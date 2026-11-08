#!/usr/bin/env node
/**
 * Manual smoke test for the perplexity-web provider's wire format.
 *
 * Loads the Perplexity session JWT exactly the way the plugin does
 * (PERPLEXITY_JWT / PERPLEXITY_COOKIES env → `defaults read ai.perplexity.mac
 * authToken` → omp's agent.db), performs ONE real `perplexity_ask` SSE query,
 * and prints the parsed answer plus citations. Never prints the JWT.
 *
 * Run from the repo root:  node plugins/perplexity-web/example.mjs "current BTC price"
 */

const ASK_URL = 'https://www.perplexity.ai/rest/sse/perplexity_ask'
const API_VERSION = '2.18'
const USER_AGENT = 'Perplexity/641 CFNetwork/1568 Darwin/25.2.0'
const OMP_DB = `${process.env.HOME}/.omp/agent/agent.db`

/** Resolve the session JWT; env wins, then the macOS app, then omp's store. */
async function resolveJwt() {
  const envJwt = process.env.PERPLEXITY_JWT?.trim()
  if (envJwt) return { token: envJwt, source: 'PERPLEXITY_JWT' }
  const envCookies = process.env.PERPLEXITY_COOKIES?.trim()
  if (envCookies) {
    const match = /__Secure-next-auth\.session-token=([^;\s]+)/.exec(envCookies)
    if (!match) return { cookies: envCookies, source: 'PERPLEXITY_COOKIES' }
    return { token: match[1], source: 'PERPLEXITY_COOKIES' }
  }
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const token = (await promisify(execFile)('defaults', ['read', 'ai.perplexity.mac', 'authToken'])).stdout.trim()
    if (token) return { token, source: 'ai.perplexity.mac defaults' }
  } catch { /* app not installed */ }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(OMP_DB, { readOnly: true })
  try {
    const row = db.prepare(
      `SELECT data FROM auth_credentials WHERE provider = 'perplexity' AND credential_type = 'oauth'
       AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1`,
    ).get()
    const token = row && JSON.parse(row.data)?.access
    if (typeof token === 'string' && token.length > 0) return { token, source: 'omp agent.db' }
  } finally { db.close() }
  throw new Error('no Perplexity session JWT found (set PERPLEXITY_JWT, or log in via omp/Perplexity app)')
}

/** Parse an SSE body into the JSON value of each event's data payload. */
async function* readSseJson(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0].length
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + separator)
        const data = rawEvent.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data.length === 0 || data === '[DONE]') continue
        try { yield JSON.parse(data) } catch { /* ignore malformed events */ }
      }
    }
  } finally { reader.releaseLock() }
}

const mergeChunks = (existing, incoming) => {
  if (!existing) return { ...incoming }
  const result = { ...existing, ...incoming }
  if (incoming.chunks?.length) {
    const offset = incoming.chunk_starting_offset ?? 0
    const prev = existing.chunks ?? []
    result.chunks = offset === 0 ? [...incoming.chunks] : [...prev.slice(0, offset), ...incoming.chunks]
  }
  return result
}

/** Snapshot-merge one stream event into the accumulated answer document. */
function mergeEvent(existing, event) {
  const merged = { ...existing, ...event }
  if (Array.isArray(event.blocks) && event.blocks.length > 0) {
    const byUsage = new Map((existing.blocks ?? [])
      .filter(block => typeof block.intended_usage === 'string' && block.intended_usage.length > 0)
      .map(block => [block.intended_usage, block]))
    for (const block of event.blocks) {
      if (!block.intended_usage) continue
      const prev = byUsage.get(block.intended_usage)
      byUsage.set(block.intended_usage, block.markdown_block
        ? { ...prev, ...block, markdown_block: mergeChunks(prev?.markdown_block, block.markdown_block) }
        : { ...prev, ...block })
    }
    merged.blocks = [...byUsage.values()]
  } else {
    merged.blocks = existing.blocks ?? []
  }
  if (merged.sources_list === undefined && existing.sources_list !== undefined) merged.sources_list = existing.sources_list
  return merged
}

function answerFrom(event) {
  const markdown = event.blocks?.find(block => block.intended_usage?.includes('markdown') && block.markdown_block)?.markdown_block
  const askText = event.blocks?.find(block => block.intended_usage === 'ask_text' && block.markdown_block)?.markdown_block
  for (const block of [markdown, askText]) {
    if (!block) continue
    if (Array.isArray(block.chunks) && block.chunks.length > 0) return block.chunks.join('')
    if (typeof block.answer === 'string' && block.answer.length > 0) return block.answer
  }
  return typeof event.text === 'string' ? event.text : ''
}

const sourceKey = url => {
  const trimmed = url.trim().replace(/\/$/, '')
  try { return new URL(trimmed).href.replace(/\/$/, '') } catch { return trimmed.toLowerCase() }
}

function sourcesFrom(event) {
  const results = event.blocks?.find(block => block.intended_usage === 'web_results')?.web_result_block?.web_results
  const listed = (results?.length ? results : event.sources_list ?? [])
    .filter(item => typeof item.url === 'string' && item.url.length > 0)
    .map(item => ({ title: item.name ?? item.title ?? item.url, url: item.url, snippet: item.snippet, publishedAt: item.timestamp ?? item.date }))
  if (listed.length > 0) return listed
  // Fall back to web_results embedded in the JSON payload of event.text.
  try {
    const payload = JSON.parse(event.text ?? '')
    const web = Array.isArray(payload?.web_results) ? payload.web_results : []
    return web.filter(item => typeof item.url === 'string' && item.url.length > 0)
      .map(item => ({ title: item.name ?? item.title ?? item.url, url: item.url, snippet: item.snippet, publishedAt: item.timestamp }))
  } catch { return [] }
}

async function main() {
  const query = process.argv[2] ?? 'current BTC price'
  const auth = await resolveJwt()
  console.error(`[smoke] JWT source: ${auth.source} (token length ${auth.token?.length ?? 0}, not printed)`)

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
    'User-Agent': USER_AGENT,
    'X-Request-ID': crypto.randomUUID(),
    // Cookie auth ONLY: any Authorization header silently downgrades to anonymous.
    'Cookie': auth.cookies ?? `__Secure-next-auth.session-token=${auth.token}`,
    'X-App-ApiClient': 'default',
    'X-App-ApiVersion': API_VERSION,
    'X-Perplexity-Request-Reason': 'submit',
  }
  const body = {
    query_str: query,
    params: {
      query_str: query,
      search_focus: 'internet',
      mode: 'copilot',
      model_preference: process.env.PI_PERPLEXITY_MODEL?.trim() || 'experimental',
      sources: ['web'],
      attachments: [],
      frontend_uuid: crypto.randomUUID(),
      frontend_context_uuid: crypto.randomUUID(),
      version: API_VERSION,
      language: 'en-US',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      search_recency_filter: null,
      is_incognito: true,
      use_schematized_api: true,
      skip_search_enabled: false,
      always_search_override: true,
      prompt_source: 'user',
      source: 'default',
      local_search_enabled: false,
      should_ask_for_mcp_tool_confirmation: false,
      supports_tool_approval_modal: false,
      force_enable_browser_agent: false,
      is_local_browser_available: false,
      is_local_browser_allowed: false,
    },
  }

  let response
  try {
    response = await fetch(ASK_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    // Transport retry: exactly once, and only when NO HTTP response arrived.
    response = await fetch(ASK_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  }
  if (!response.ok) {
    console.error(`[smoke] HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
    process.exitCode = 1
    return
  }

  let merged = { blocks: [] }
  for await (const event of readSseJson(response.body)) {
    if (event.error_code) {
      console.error(`[smoke] stream error: ${event.error_message ?? event.error_code}`)
      process.exitCode = 1
      return
    }
    merged = mergeEvent(merged, event)
    if (merged.final || merged.final_sse_message || merged.status === 'COMPLETED') break
  }

  const answer = answerFrom(merged)
  const seen = new Set()
  const sources = sourcesFrom(merged).filter(source => !seen.has(sourceKey(source.url)) && seen.add(sourceKey(source.url)))
  console.error(`[smoke] model: ${merged.user_selected_model ?? merged.display_model ?? '?'} status: ${merged.status ?? '?'}`)
  console.log(`# Answer\n${answer || '(empty answer)'}\n`)
  console.log(`# Sources (${sources.length})`)
  for (const source of sources.slice(0, 10)) console.log(`- [${source.title}](${source.url})${source.snippet ? ` — ${source.snippet.slice(0, 120)}` : ''}`)
  // The anonymous wall answers HTTP 200 with "Sign up and repeat your request." and no sources.
  if (sources.length === 0 && /sign up/i.test(answer)) {
    console.error('[smoke] anonymous-wall response (no sources, sign-up text) — cookie auth did not take effect')
    process.exitCode = 1
  }
}

await main()
