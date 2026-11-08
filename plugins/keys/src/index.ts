/**
 * keys, node half. Host-side fallback for message full-text search.
 *
 * The sanctioned `session.search` content index is opt-in — dsh-base mounts
 * `session-query-sqlite` with `openAt: never`, so content queries fail with
 * `SESSION_QUERY_SEARCH_DISABLED` and the Web sidebar degrades to titles. When
 * the browser half sees that failure it calls this plugin's route instead:
 * a bounded scan over the persisted transcripts (most recently written
 * sessions first, case-insensitive substring, matched line ±1, capped at the
 * same 20-result bound the wire schema fixes), served through the same
 * same-origin JSON + request-fence idiom as the dashboard routes.
 * @module keys
 */

import { homedir } from 'node:os'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Sessions scanned per query, most recently written first. */
const RECENT_SESSIONS = 30

/** Result cap — mirrors `SESSION_SEARCH_RESULT_LIMIT` on the wire. */
const RESULT_LIMIT = 20

/** Events scanned per session, taken from the log's tail. */
const TAIL_EVENTS = 800

/** Fallback when a snapshot carries no cheap event count. */
const MAX_EVENTS_UNCOUNTED = 5_000

/** Snippet budget (characters) after folding the ±1 line context. */
const SNIPPET_MAX = 240

/** Host services this plugin requires. `sessionPersistence` is mounted by
 *  dsh-base (`session-persistence-jsonl`); the plugin loads only where it
 *  exists, same contract as the dashboard's `webServer` requirement. */
export const inject = ['webServer', 'sessionPersistence']

/** Minimal runtime faces of the session-persistence service (see
 *  `@deepseek-ai/dsh-session-persistence`); structural on purpose so the
 *  plugin carries no dependency beyond the host that mounts it. */
interface SessionSnapshotLike {
  readonly header: { readonly id: string; readonly createdAt: number }
  readonly eventCount?: number
  readonly location?: { readonly kind: string; readonly path: string }
}

interface SessionHandleLike {
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{
    readonly events: readonly SessionEventLike[]
  }>
  close(): Promise<void>
}

/** Only the message events' text-bearing shapes are inspected (mirrors the
 *  sanctioned index's `user/message`/`assistant/message` filter). */
interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

interface SessionPersistenceLike {
  list(options?: { signal?: AbortSignal }): Promise<readonly SessionSnapshotLike[]>
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<SessionHandleLike>
}

/** The service row `inject` guarantees; structural (no persistence import). */
interface KeysHostContext extends Context {
  readonly sessionPersistence?: SessionPersistenceLike
}

/** Message search route: `POST /api/keys/messages` answers bounded snippets. */
export function makeKeysMessagesRoute(ctx: KeysHostContext): WebRoute {
  return {
    kind: 'exact',
    path: '/api/keys/messages',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        if (req.method !== 'POST' || !isMessagesRequestAllowed(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const body = await readJsonBody(req)
        let query = ''
        if (typeof body === 'object' && body !== null && 'query' in body && typeof body.query === 'string') {
          query = body.query.trim()
        }
        if (query === '') {
          writeJson(res, 200, { ok: true, value: { items: [], hasMore: false } }, { 'cache-control': 'no-store' })
          return
        }
        const persistence = ctx.sessionPersistence
        if (persistence === undefined) {
          writeJson(res, 200, { ok: false, error: 'session persistence is not mounted' }, { 'cache-control': 'no-store' })
          return
        }
        const controller = new AbortController()
        res.once('close', () => controller.abort())
        const items = await scanTranscripts(persistence, query, controller.signal)
        writeJson(res, 200, {
          ok: true,
          value: { items, hasMore: items.length >= RESULT_LIMIT },
        }, { 'cache-control': 'no-store' })
      } catch (error) {
        if (!res.headersSent) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) }, { 'cache-control': 'no-store' })
        }
      }
    },
  }
}

/** Host plugin body: register the fallback message-search route, tied to this fiber. */
export function apply(ctx: KeysHostContext): void {
  const disposeRoute = ctx.webServer.register(makeKeysMessagesRoute(ctx))
  ctx.effect(() => disposeRoute, 'keys: messages route')
}

/** Resolve the DSH home directory the way the host does: env override, then ~/.dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim()
  if (raw !== undefined && raw !== '') {
    return isAbsolute(raw) ? raw : join(process.cwd(), raw)
  }
  return join(homedir(), '.dsh')
}

/** Family-default JSON response headers; callers may append or override. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

function writeJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

/** Whether a request carries headers stamped by a forwarding hop (proxy/tunnel). */
function isProxiedRequest(request: IncomingMessage): boolean {
  return request.headers['cf-connecting-ip'] !== undefined || request.headers['x-forwarded-for'] !== undefined
}

/**
 * Whether this request may scan transcripts: a same-origin/same-site browser
 * request (the audience the web app already serves transcripts to) or a
 * loopback socket (local tools); never a proxied request. Deliberately wider
 * than the dashboard's loopback fence: transcripts are already readable by
 * every admitted Web client, so a loopback-only fence adds no privacy.
 */
function isMessagesRequestAllowed(request: IncomingMessage): boolean {
  if (isProxiedRequest(request)) return false
  const site = request.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return true
  const remote = request.socket.remoteAddress?.toLowerCase() ?? ''
  return remote === '::1' || remote.startsWith('::ffff:127.') || remote.startsWith('127.')
}

/** Read one small JSON request body; undefined on anything unusual. */
async function readJsonBody(request: IncomingMessage, limit = 8_192): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > limit) return undefined
      chunks.push(chunk as Buffer)
    }
  } catch {
    // aborted or malformed body — the route answers its empty/forbidden paths
    return undefined
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** Message text of one event: 'user/message' / 'assistant/message' text blocks. */
function messageText(event: SessionEventLike): string | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data as { content?: unknown; message?: { content?: unknown } } | null
  if (typeof data !== 'object' || data === null) return undefined
  const content = event.type === 'user/message' ? data.content : data.message?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Snippet around the first case-insensitive match: the matched line plus one
 * neighbour on each side, folded to `SNIPPET_MAX` characters.
 */
function snippetAround(haystack: string, needle: string): string | undefined {
  const lower = haystack.toLowerCase()
  const at = lower.indexOf(needle)
  if (at < 0) return undefined
  const lines = haystack.split('\n')
  const lineEnds: number[] = []
  let offset = 0
  for (const line of lines) {
    offset += line.length + 1
    lineEnds.push(offset)
  }
  let index = lineEnds.findIndex(end => at < end)
  if (index < 0) index = lines.length - 1
  const from = Math.max(0, index - 1)
  const to = Math.min(lines.length, index + 2)
  let snippet = lines.slice(from, to).join(' ⏎ ').trim()
  if (snippet.length > SNIPPET_MAX) {
    const anchor = Math.max(0, Math.min(snippet.length - SNIPPET_MAX, at - from === 0 ? at : SNIPPET_MAX))
    snippet = `${anchor > 0 ? '…' : ''}${snippet.slice(anchor, anchor + SNIPPET_MAX)}…`
  }
  return snippet
}

interface ScanItem {
  readonly sessionId: string
  readonly snippet: string
}

/** One bounded scan: recent sessions first, tail events per session, early exit at the cap. */
async function scanTranscripts(persistence: SessionPersistenceLike, query: string, signal: AbortSignal): Promise<ScanItem[]> {
  const needle = query.toLowerCase()
  const snapshots = await persistence.list({ signal })
  // Most recently written first: artifact mtime when the backend names one,
  // creation time as the fallback order.
  const ranked = snapshots.map(snapshot => ({ snapshot, at: snapshot.header.createdAt }))
  await Promise.all(ranked.map(async entry => {
    const path = entry.snapshot.location?.path
    if (path === undefined) return
    try {
      entry.at = (await stat(path)).mtimeMs
    } catch {
      // unmaterialized or vanished artifact — creation time stands
    }
  }))
  ranked.sort((a, b) => b.at - a.at)
  const items: ScanItem[] = []
  for (const { snapshot } of ranked.slice(0, RECENT_SESSIONS)) {
    if (signal.aborted || items.length >= RESULT_LIMIT) break
    let handle: SessionHandleLike | undefined
    try {
      handle = await persistence.open(snapshot.header.id, 'read', { signal })
    } catch {
      continue // vanished between list and open, or locked — skip, not fail
    }
    try {
      const count = snapshot.eventCount
      const [offset, length] = count === undefined
        ? [0, MAX_EVENTS_UNCOUNTED]
        : [Math.max(0, count - TAIL_EVENTS), TAIL_EVENTS]
      const { events } = await handle.read(offset, length, { signal })
      for (const event of events) {
        if (items.length >= RESULT_LIMIT) break
        const text = messageText(event)
        if (text === undefined || !text.toLowerCase().includes(needle)) continue
        const snippet = snippetAround(text, needle)
        if (snippet !== undefined) items.push({ sessionId: snapshot.header.id, snippet })
      }
    } catch {
      // unreadable log — skip this session
    } finally {
      void handle.close().catch(() => {})
    }
  }
  return items
}

