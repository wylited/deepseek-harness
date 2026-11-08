/**
 * The Perplexity consumer ask endpoint (`POST /rest/sse/perplexity_ask`)
 * streamed with cookie auth — a direct port of oh-my-pi's OAuth search path.
 *
 * Wire contract (verified against the live endpoint):
 * - Authenticate ONLY via `Cookie: __Secure-next-auth.session-token=<jwt>`.
 *   Any `Authorization` header is silently ignored and the request downgrades
 *   to the anonymous free tier.
 * - The endpoint has no system-message slot; send the bare query.
 * - `skip_search_enabled: false` plus `always_search_override: true` force
 *   retrieval; the backend otherwise answers some queries ungrounded.
 * - Each SSE `data:` line is one JSON snapshot of the whole answer document.
 *   Snapshots merge (spread, then per-`intended_usage` block merge with
 *   markdown chunk splicing at `chunk_starting_offset`); the stream ends at
 *   `final === true`, `final_sse_message === true`, or `status === 'COMPLETED'`.
 * - The anonymous wall answers HTTP 200 with "Sign up and repeat your
 *   request." and zero sources — classified as a failure, not an empty success.
 * @module perplexity-web/ask
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { cookieHeaderOf, invalidatePerplexityCredential, resolvePerplexityCredential } from './auth.ts'
import type { PerplexityCredential } from './auth.ts'

/** `https://www.perplexity.ai/rest/sse/perplexity_ask` — the consumer ask endpoint. */
export const PERPLEXITY_ASK_URL = 'https://www.perplexity.ai/rest/sse/perplexity_ask'

/** App-version header pair the native client sends; the endpoint gates on them. */
const API_VERSION = '2.18'
const USER_AGENT = 'Perplexity/641 CFNetwork/1568 Darwin/25.2.0'

/** One citeable result as the stream reports it. */
export interface AskSource {
  readonly url: string
  readonly title: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** One completed ask: the grounded answer, its deduped sources, and the serving model when reported. */
export interface AskResult {
  readonly answer: string
  readonly sources: readonly AskSource[]
  readonly model?: string
}

/** Options for one ask. */
export interface AskOptions {
  /** The bare search query; the endpoint has no system-message slot. */
  readonly query: string
  /** Consumer subscription model preference (`model_preference`); e.g. `experimental`, `turbo`, `sonar`. */
  readonly model?: string
  /** Cooperative caller cancellation. */
  readonly signal?: AbortSignal
  /** Hard budget for the whole request including the stream; exceeded → {@link PERPLEXITY_TIMEOUT}. */
  readonly timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Stream event vocabulary
// ---------------------------------------------------------------------------

interface StreamMarkdownBlock {
  answer?: string
  chunks?: string[]
  chunk_starting_offset?: number
}

interface StreamWebResult {
  name?: string
  url?: string
  snippet?: string
  timestamp?: string
}

interface StreamBlock {
  intended_usage?: string
  markdown_block?: StreamMarkdownBlock
  web_result_block?: { web_results?: StreamWebResult[] }
}

interface StreamSource {
  title?: string
  url?: string
  snippet?: string
  date?: string
}

/** One SSE snapshot. Every field optional; events are deltas that merge into one document. */
interface StreamEvent {
  status?: string
  final?: boolean
  final_sse_message?: boolean
  text?: string
  blocks?: StreamBlock[]
  sources_list?: StreamSource[]
  error_code?: string
  error_message?: string
  display_model?: string
  user_selected_model?: string
}

/** Merged answer document accumulated across snapshots. */
interface MergedEvent extends StreamEvent {
  blocks: StreamBlock[]
}

// ---------------------------------------------------------------------------
// Snapshot merging
// ---------------------------------------------------------------------------

/** Splice incoming markdown chunks at `chunk_starting_offset`, exactly like the web client. */
function mergeMarkdownBlock(existing: StreamMarkdownBlock | undefined, incoming: StreamMarkdownBlock): StreamMarkdownBlock {
  if (!existing) return { ...incoming }
  const result: StreamMarkdownBlock = { ...existing, ...incoming }
  if (incoming.chunks?.length) {
    const offset = incoming.chunk_starting_offset ?? 0
    const existingChunks = existing.chunks ?? []
    result.chunks = offset === 0 ? [...incoming.chunks] : [...existingChunks.slice(0, offset), ...incoming.chunks]
  }
  return result
}

function mergeBlocks(existing: StreamBlock[], incoming: StreamBlock[]): StreamBlock[] {
  const blockMap = new Map<string, StreamBlock>(
    existing
      .filter(block => typeof block.intended_usage === 'string' && block.intended_usage.length > 0)
      .map(block => [block.intended_usage as string, block]),
  )
  for (const block of incoming) {
    if (!block.intended_usage) continue
    const prev = blockMap.get(block.intended_usage)
    blockMap.set(block.intended_usage, block.markdown_block
      ? { ...prev, ...block, markdown_block: mergeMarkdownBlock(prev?.markdown_block, block.markdown_block) }
      : { ...prev, ...block })
  }
  return [...blockMap.values()]
}

/** Fold one snapshot into the merged document; absent `sources_list` inherits. */
function mergeEvent(existing: MergedEvent, event: StreamEvent): MergedEvent {
  const merged: MergedEvent = { ...existing, ...event }
  merged.blocks = event.blocks?.length ? mergeBlocks(existing.blocks, event.blocks) : existing.blocks
  if (merged.sources_list === undefined && existing.sources_list !== undefined) merged.sources_list = existing.sources_list
  return merged
}

// ---------------------------------------------------------------------------
// Answer and source extraction
// ---------------------------------------------------------------------------

function answerFromMarkdownBlock(block: StreamMarkdownBlock | undefined): string | undefined {
  if (!block) return undefined
  if (Array.isArray(block.chunks) && block.chunks.length > 0) return block.chunks.join('')
  if (typeof block.answer === 'string' && block.answer.length > 0) return block.answer
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textFromChunks(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null
  let text = ''
  for (const chunk of value) {
    if (typeof chunk !== 'string') return null
    text += chunk
  }
  return text.length > 0 ? text : null
}

/**
 * Unwrap the JSON payload carried in `event.text`: `{ structured_answer[].text |
 * chunks, chunks[], answer }` in preference order. Undefined when `text` is not
 * such a payload.
 */
function payloadFromText(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const direct = asRecord(parsed)
  if (direct) return direct
  if (!Array.isArray(parsed)) return undefined
  for (const item of parsed) {
    const answer = asRecord(asRecord(item)?.content)?.answer
    if (typeof answer !== 'string' || answer.length === 0) continue
    const payload = asRecord(JSON.parse(answer))
    if (payload) return payload
  }
  return undefined
}

function answerFromTextPayload(payload: Record<string, unknown>): string | undefined {
  const structured = payload.structured_answer
  if (Array.isArray(structured)) {
    for (const item of structured) {
      const record = asRecord(item)
      if (!record) continue
      const text = typeof record.text === 'string' && record.text.length > 0 ? record.text : textFromChunks(record.chunks)
      if (text) return text
    }
  }
  return textFromChunks(payload.chunks)
    ?? (typeof payload.answer === 'string' && payload.answer.length > 0 ? payload.answer : undefined)
}

/** The answer text: markdown block, then `ask_text` block, then the `text` payload's answer, then raw `text`. */
function answerFrom(event: MergedEvent): string {
  const markdown = event.blocks.find(block => block.intended_usage?.includes('markdown') && block.markdown_block)?.markdown_block
  const fromMarkdown = answerFromMarkdownBlock(markdown)
  if (fromMarkdown !== undefined) return fromMarkdown
  const askText = event.blocks.find(block => block.intended_usage === 'ask_text' && block.markdown_block)?.markdown_block
  const fromAskText = answerFromMarkdownBlock(askText)
  if (fromAskText !== undefined) return fromAskText
  if (typeof event.text === 'string' && event.text.length > 0) {
    const payload = payloadFromText(event.text)
    const fromPayload = payload !== undefined ? answerFromTextPayload(payload) : undefined
    if (fromPayload !== undefined) return fromPayload
    // `text` may also be a JSON array of steps whose answer hides in content.
    try {
      const steps: unknown = JSON.parse(event.text)
      if (Array.isArray(steps)) {
        for (const step of steps) {
          const answer = asRecord(asRecord(step)?.content)?.answer
          if (typeof answer === 'string' && answer.length > 0) return answer
        }
      }
    } catch { /* plain text answer */ }
    return event.text
  }
  return ''
}

function toSource(item: { name?: string; title?: string; url?: string; snippet?: string; timestamp?: string; date?: string }): AskSource | undefined {
  if (typeof item.url !== 'string' || item.url.length === 0) return undefined
  const title = (item.name ?? item.title)
  return {
    url: item.url,
    title: typeof title === 'string' && title.length > 0 ? title : item.url,
    ...(typeof item.snippet === 'string' && item.snippet.length > 0 ? { snippet: item.snippet } : {}),
    ...(typeof item.timestamp === 'string' ? { publishedAt: item.timestamp } : typeof item.date === 'string' ? { publishedAt: item.date } : {}),
  }
}

/** Dedup key: canonical URL when parseable, lowercased string otherwise. */
function sourceKey(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '')
  try {
    return new URL(trimmed).href.replace(/\/$/, '')
  } catch {
    return trimmed.toLowerCase()
  }
}

/** Sources: the `web_results` block, else `sources_list`, else `web_results` inside the `text` payload. */
function sourcesFrom(event: MergedEvent): AskSource[] {
  const byUrl = new Map<string, AskSource>()
  const add = (item: Parameters<typeof toSource>[0]): void => {
    const source = toSource(item)
    if (source !== undefined && !byUrl.has(sourceKey(source.url))) byUrl.set(sourceKey(source.url), source)
  }
  for (const result of event.blocks.find(block => block.intended_usage === 'web_results')?.web_result_block?.web_results ?? []) add(result)
  if (byUrl.size === 0) for (const source of event.sources_list ?? []) add(source)
  if (byUrl.size === 0) {
    const payload = payloadFromText(event.text)
    for (const result of (asRecord(payload?.web_results) && Array.isArray(payload?.web_results)
      ? payload?.web_results as unknown[]
      : []) as Parameters<typeof toSource>[0][]) add(result)
  }
  return [...byUrl.values()]
}

// ---------------------------------------------------------------------------
// SSE reading
// ---------------------------------------------------------------------------

/** Yield each event's parsed `data:` JSON; malformed and empty events are skipped. */
async function* readSseJson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const separatorLength = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length ?? 2
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + separatorLength)
        const data = rawEvent.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data.length === 0 || data === '[DONE]') continue
        try {
          const parsed: unknown = JSON.parse(data)
          const event = asRecord(parsed)
          if (event) yield event as StreamEvent
        } catch { /* keep-alive or malformed frame: skip */ }
      }
    }
  } finally {
    // Early exit (final event or a consumer break) must cancel the body so
    // the socket returns to the pool instead of staying open.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    void signal
  }
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Stable failure codes this provider reports on the web seam. */
export type PerplexityFailure =
  | 'PERPLEXITY_NO_CREDENTIAL'
  | 'PERPLEXITY_REJECTED_CREDENTIAL'
  | 'PERPLEXITY_ANONYMOUS_WALL'
  | 'PERPLEXITY_TIMEOUT'
  | 'PERPLEXITY_STREAM_ERROR'
  | 'PERPLEXITY_REQUEST_FAILED'

function askError(code: PerplexityFailure, message: string, cause?: unknown): WebError {
  return new WebError(message, code, cause === undefined ? undefined : { cause })
}

// ---------------------------------------------------------------------------
// The ask call
// ---------------------------------------------------------------------------

/** One ask: cookie-authenticated SSE round trip. Transport retries once, and only when no HTTP response arrived. */
export async function askPerplexity(options: AskOptions): Promise<AskResult> {
  const { query, signal, timeoutMs } = options
  const model = options.model?.trim() || process.env.PI_PERPLEXITY_MODEL?.trim() || 'experimental'

  // The caller's signal and the hard budget race one fetch; timeout surfaces as
  // PERPLEXITY_TIMEOUT, caller abort as WEB_ABORTED.
  const timeoutSignal = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined
  const requestSignal = signal !== undefined && timeoutSignal !== undefined
    ? AbortSignal.any([signal, timeoutSignal])
    : signal ?? timeoutSignal
  throwIfAborted(signal)

  const requestId = crypto.randomUUID()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
    // The native client's UA; the endpoint gates app headers on it.
    'User-Agent': USER_AGENT,
    'X-Request-ID': requestId,
    // NO Authorization header, ever: it is ignored and downgrades to anonymous.
    'X-App-ApiClient': 'default',
    'X-App-ApiVersion': API_VERSION,
    'X-Perplexity-Request-Reason': 'submit',
  }
  let credential: PerplexityCredential
  try {
    credential = await resolvePerplexityCredential()
  } catch (error: unknown) {
    throw askError('PERPLEXITY_NO_CREDENTIAL', String((error as Error)?.message ?? error))
  }
  throwIfAborted(signal)
  headers.Cookie = cookieHeaderOf(credential)

  const body = JSON.stringify({
    query_str: query,
    params: {
      query_str: query,
      search_focus: 'internet',
      mode: 'copilot',
      model_preference: model,
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
      // Force retrieval: without these the backend classifier answers some
      // queries from memory, and the model then refuses with "I don't
      // currently have live access".
      skip_search_enabled: false,
      always_search_override: true,
      prompt_source: 'user',
      source: 'default',
      local_search_enabled: false,
      // No tool-approval UI and no local browser agent: the stream must never
      // stall waiting for a confirmation we cannot render.
      should_ask_for_mcp_tool_confirmation: false,
      supports_tool_approval_modal: false,
      force_enable_browser_agent: false,
      is_local_browser_available: false,
      is_local_browser_allowed: false,
    },
  })

  const dispatch = (): Promise<Response> => fetch(PERPLEXITY_ASK_URL, {
    method: 'POST',
    headers,
    body,
    ...(requestSignal !== undefined ? { signal: requestSignal } : {}),
  })

  let response: Response
  try {
    response = await dispatch()
  } catch (error: unknown) {
    // Transport retry: exactly once, and only when NO HTTP response arrived at
    // all (the endpoint intermittently drops the socket). Once a response
    // exists, its outcome is final — a real 401/429 is never retried.
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    if (timeoutSignal?.aborted) throw askError('PERPLEXITY_TIMEOUT', `Perplexity ask exceeded its ${timeoutMs ?? '?'}ms budget`)
    try {
      response = await dispatch()
    } catch (retryError: unknown) {
      if (isAbortError(retryError)) throw abortedError(signal, retryError)
      // Fresh abort re-read: the caller can cancel during the awaited retry.
      throwIfAborted(signal)
      if (timeoutSignal?.aborted) throw askError('PERPLEXITY_TIMEOUT', `Perplexity ask exceeded its ${timeoutMs ?? '?'}ms budget`)
      throw askError('PERPLEXITY_REQUEST_FAILED', `Perplexity ask request failed twice (no HTTP response): ${String(retryError)}`, retryError)
    }
  }
  throwIfAborted(signal)

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    if (response.status === 401 || response.status === 403) {
      // The stored session may be rotated or signed out; re-resolve next time.
      invalidatePerplexityCredential()
      throw askError(
        'PERPLEXITY_REJECTED_CREDENTIAL',
        `Perplexity rejected the session credential (HTTP ${response.status}). The user must sign in again `
        + '(Perplexity app, oh-my-pi, or set PERPLEXITY_JWT / PERPLEXITY_COOKIES).',
      )
    }
    if (response.status === 429) {
      throw askError('PERPLEXITY_REQUEST_FAILED', `Perplexity rate limited the ask request (HTTP 429): ${errorText.slice(0, 200)}`)
    }
    throw askError('PERPLEXITY_REQUEST_FAILED', `Perplexity ask API error (HTTP ${response.status}): ${errorText.slice(0, 300)}`)
  }
  if (response.body === null) {
    throw askError('PERPLEXITY_REQUEST_FAILED', 'Perplexity ask API returned no response body')
  }

  let merged: MergedEvent = { blocks: [] }
  try {
    for await (const event of readSseJson(response.body, requestSignal)) {
      if (event.error_code !== undefined) {
        throw askError('PERPLEXITY_STREAM_ERROR', `Perplexity ask stream error: ${event.error_message ?? event.error_code}`)
      }
      merged = mergeEvent(merged, event)
      if (event.final === true || event.final_sse_message === true || event.status === 'COMPLETED') break
    }
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal, error)
    if (timeoutSignal?.aborted) throw askError('PERPLEXITY_TIMEOUT', `Perplexity ask exceeded its ${timeoutMs ?? '?'}ms budget`)
    throw askError('PERPLEXITY_STREAM_ERROR', `Perplexity ask stream failed: ${String(error)}`, error)
  }
  throwIfAborted(signal)

  const answer = answerFrom(merged)
  const sources = sourcesFrom(merged)
  // The anonymous wall: HTTP 200, a sign-up plea, and zero sources — auth did
  // not take effect. Report failure, not an empty success.
  if (sources.length === 0 && answer.length === 0) {
    throw askError(
      'PERPLEXITY_ANONYMOUS_WALL',
      'Perplexity answered without any answer text or sources; the session credential was not accepted and the '
      + 'request ran on the anonymous tier. Check the credential source and that the account can search.',
    )
  }
  if (sources.length === 0 && /sign up|create an account|please repeat/i.test(answer)) {
    throw askError(
      'PERPLEXITY_ANONYMOUS_WALL',
      `Perplexity responded with the anonymous sign-up wall (no sources): ${answer.slice(0, 200)}`,
    )
  }
  const reportedModel = [merged.user_selected_model, merged.display_model].find(
    candidate => candidate !== undefined && candidate !== 'turbo',
  )
  return {
    answer,
    sources,
    ...(reportedModel !== undefined ? { model: reportedModel } : {}),
  }
}

/** Throw the seam's cancellation error when the caller already aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortedError(signal)
}

/** The web seam's stable cancellation code, retaining the abort reason. */
function abortedError(signal: AbortSignal | undefined, fallback?: unknown): WebError {
  return new WebError('Perplexity search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, which surfaces as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
