/**
 * The attention route: open web pages report focus state so the notify
 * service can suppress Discord pings only while someone is actually
 * looking. Same-origin fence only — the report is low-stakes (worst case a
 * forged body silences or releases the owner's own notifications), but a
 * stranger must not be able to pin the gate either way.
 * @module notify/host/attention-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** The attention endpoint path (same-origin fetch from the client half). */
export const NOTIFY_ATTENTION_PATH = '/api/notify/attention'

/** Whether the request names this origin (same-origin marker or loopback). */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  const address = req.socket.remoteAddress
  if (address !== undefined
    && (address === '::1' || address === '::ffff:127.0.0.1' || address.endsWith(':127.0.0.1'))) {
    return true
  }
  return false
}

/** Write one JSON body and finish the response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Build the POST route. Bodies are tiny JSON `{ pageId, focused }`; anything
 * else answers 400 and changes nothing.
 * @param setAttention - the service's focus recorder.
 */
export function makeNotifyAttentionRoute(
  setAttention: (pageId: string, focused: boolean) => void,
): WebRoute {
  return {
    kind: 'exact',
    path: NOTIFY_ATTENTION_PATH,
    handler: (req: IncomingMessage, res: ServerResponse): void => {
      if (req.method !== 'POST' || !isSameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: same-origin only' })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= 4096) chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof parsed !== 'object' || parsed === null) {
            writeJson(res, 400, { ok: false, error: 'bad body' })
            return
          }
          const record = parsed as Record<string, unknown>
          const pageId = record['pageId']
          const focused = record['focused']
          if (typeof pageId !== 'string' || pageId === '' || typeof focused !== 'boolean') {
            writeJson(res, 400, { ok: false, error: 'bad body' })
            return
          }
          setAttention(pageId, focused)
          writeJson(res, 200, { ok: true })
        } catch {
          writeJson(res, 400, { ok: false, error: 'bad body' })
        }
      })
      req.on('error', () => writeJson(res, 400, { ok: false, error: 'bad body' }))
    },
  }
}
