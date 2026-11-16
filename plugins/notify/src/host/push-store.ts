/**
 * Push subscription store + HTTP routes. Subscriptions live OUTSIDE the repo:
 * `$DSH_HOME/notify/push-subscriptions.json` (0600-style, same state area the
 * credentials seam guards). Endpoints are opaque URLs bound to one browser —
 * not secrets, but never logged.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import type { PushSubscriptionRecord } from './push.ts'

/** One stored browser subscription (the PushSubscription JSON the client POSTs). */
const PushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
})

const SubscribePayload = z.object({ subscription: PushSubscriptionSchema })

interface StoreShape {
  version: 1
  subscriptions: PushSubscriptionRecord[]
}

/** Load all subscriptions; a missing or corrupt file yields an empty store. */
export function loadSubscriptions(homePath: string): PushSubscriptionRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(subscriptionsPath(homePath), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('subscriptions' in parsed)) return []
    const raw: unknown = (parsed as { subscriptions: unknown }).subscriptions
    if (!Array.isArray(raw)) return []
    const records: PushSubscriptionRecord[] = []
    for (const entry of raw) {
      const candidate = PushSubscriptionSchema(entry) as PushSubscriptionRecord
      if (!candidate.endpoint.startsWith('https://')) continue
      if (typeof candidate.keys?.p256dh !== 'string' || typeof candidate.keys?.auth !== 'string') continue
      records.push(candidate)
    }
    return records
  } catch {
    return []
  }
}

/** Atomically replace the subscription list. */
export function saveSubscriptions(homePath: string, subscriptions: PushSubscriptionRecord[]): void {
  const path = subscriptionsPath(homePath)
  mkdirSync(dirname(path), { recursive: true })
  const store: StoreShape = { version: 1, subscriptions }
  writeFileSync(`${path}.tmp`, JSON.stringify(store, null, 2))
  renameSync(`${path}.tmp`, path)
}

export function subscriptionsPath(homePath: string): string {
  return join(homePath, 'notify', 'push-subscriptions.json')
}

/** Upsert by endpoint; returns the full list. */
export function upsertSubscription(homePath: string, record: PushSubscriptionRecord): PushSubscriptionRecord[] {
  const all = loadSubscriptions(homePath).filter(s => s.endpoint !== record.endpoint)
  all.push(record)
  saveSubscriptions(homePath, all)
  return all
}

export function removeSubscription(homePath: string, endpoint: string): PushSubscriptionRecord[] {
  const all = loadSubscriptions(homePath).filter(s => s.endpoint !== endpoint)
  saveSubscriptions(homePath, all)
  return all
}

/** Route shape shared with attention-route: minimal exact-path JSON handler. */
export interface PushRouteDeps {
  /** Public VAPID key (config); '' = push disabled. */
  publicKey: string
  homePath: string
}

const MAX_BODY_BYTES = 8 * 1024

/** Whether the request names this origin (same-origin marker or loopback). */
function isSameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  const address = req.socket.remoteAddress
  return address !== undefined
    && (address === '::1' || address === '::ffff:127.0.0.1' || address.endsWith(':127.0.0.1'))
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Read a small JSON body or undefined. */
function readBody(req: IncomingMessage, res: ServerResponse, onBody: (raw: string) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= MAX_BODY_BYTES) chunks.push(chunk)
  })
  req.on('end', () => onBody(Buffer.concat(chunks).toString('utf8')))
  req.on('error', () => writeJson(res, 400, { ok: false, error: 'bad body' }))
}

/**
 * Build the subscription endpoints (public key + subscribe). Register
 * alongside the attention route; both sit behind the webserver's auth fence.
 */
export function makePushRoutes(deps: PushRouteDeps): WebRoute[] {
  return [
    {
      kind: 'exact',
      path: '/api/notify/push-key',
      handler: (req, res): void => {
        if (!isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: same-origin only' })
          return
        }
        writeJson(res, 200, { publicKey: deps.publicKey, supported: deps.publicKey.length > 0 })
      },
    },
    {
      kind: 'exact',
      path: '/api/notify/push-subscribe',
      handler: (req, res): void => {
        if (req.method !== 'POST' || !isSameOrigin(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: same-origin POST only' })
          return
        }
        readBody(req, res, (raw) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            writeJson(res, 400, { ok: false, error: 'bad body' })
            return
          }
          // The vendored schemastery is lenient (no throw on missing fields),
          // so every field is checked here as well.
          const outer = SubscribePayload(parsed) as { subscription?: Partial<PushSubscriptionRecord> }
          const sub = outer.subscription
          if (sub === undefined
            || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')
            || sub.keys === undefined
            || typeof sub.keys.p256dh !== 'string' || sub.keys.p256dh.length === 0
            || typeof sub.keys.auth !== 'string' || sub.keys.auth.length === 0) {
            writeJson(res, 400, { ok: false, error: 'bad subscription' })
            return
          }
          const record: PushSubscriptionRecord = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            addedAt: new Date().toISOString(),
          }
          const total = upsertSubscription(deps.homePath, record).length
          writeJson(res, 200, { ok: true, total })
        })
      },
    },
  ]
}
