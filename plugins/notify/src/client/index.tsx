/**
 * notify, client half. In-page attention toasts over the shared shell
 * overlay: when a followed session asks a question or finishes with a final
 * message while that session is NOT the one on screen, a `Toast` (the shared
 * ui-primitives banner — no plugin CSS, so the upstream mobile-safe styling
 * applies) names the session and offers an Open action. When the tab is
 * hidden and the browser permission is granted, the same moment also raises a
 * system notification.
 *
 * Suppression (the core rule): a toast is skipped entirely when the user is
 * actively reading the very session the news belongs to — visible document
 * AND that session retained by the main view (`sessions.list` row's
 * `retainedBy.mainView > 0`, the same fact ui-session uses to decide
 * "completion unread"). There is no richer viewed-session signal client-side;
 * this is the simplest correct one.
 *
 * Host events are consumed through the forwarded feed only (`ctx.remote.$on`),
 * so this half never polls: `api-session/status` running→false announces a
 * finished turn, and the `user-questions/request` waterfall (always delegated
 * with `next()`) announces a pending question without touching the answerer.
 * @module notify/client
 */

import { useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** The shared Toast primitive, resolved from the boot graph's module table. */
declare function require(id: string): unknown

/** Structural React node; the plugin renders only through the shared Toast. */
type ReactNode = unknown

interface ToastProps {
  text: string
  holdMs?: number
  actions?: readonly { label: string; onClick: () => void }[]
  onDone: () => void
}

/** The `@deepseek-ai/dsh-client-ui-primitives` face notify seats. */
interface UiPrimitives {
  Toast: (props: ToastProps) => ReactNode
}

/** Toast hold before fade: questions wait for the user, completions do not. */
const QUESTION_HOLD_MS = 12_000
const DONE_HOLD_MS = 6_000

/** One queued toast with its Open target. */
interface ToastItem {
  readonly id: number
  readonly text: string
  readonly holdMs: number
  readonly sessionId: string | undefined
}

/** Minimal ordered toast queue; the overlay host renders the head, one at a time. */
class ToastQueue {
  private items: readonly ToastItem[] = []
  private sequence = 0
  private readonly listeners = new Set<() => void>()

  push(item: Omit<ToastItem, 'id'>): ToastItem {
    const full: ToastItem = { ...item, id: ++this.sequence }
    this.items = [...this.items, full]
    this.changed()
    return full
  }

  drop(id: number): void {
    const next = this.items.filter(item => item.id !== id)
    if (next.length === this.items.length) return
    this.items = next
    this.changed()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): readonly ToastItem[] => this.items

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Client faces notify integrates with; all structural, all optional. */
interface SessionsFace {
  scopeOf(scope: unknown): string | undefined
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): { byId: Record<string, SessionRow | undefined> }
  }
}

interface SessionRow {
  readonly displayTitle?: string
  readonly origin?: string
  readonly retainedBy?: { readonly mainView?: number }
}

interface RemoteFace {
  $on(name: 'api-session/status',
    listener: (this: ClientContext, sessionId: string, running: boolean) => void): () => void
  $on(name: 'user-questions/request',
    listener: (this: ClientContext, request: QuestionRequest, next: () => Promise<unknown>) => Promise<unknown>): () => void
}
/** Forwarded question waterfall payload (the subset the toast reads). */
interface QuestionRequest {
  readonly questions?: readonly {
    readonly question?: string
    readonly detail?: string
    readonly header?: string
  }[]
}

interface SessionRemoteFace {
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    maxMessages?: number
  }, signal?: AbortSignal): AsyncIterable<unknown>
}

interface SlotsFace {
  inject(slot: string, register: () => unknown): unknown
  register(registration: {
    name: string
    id: string
    inject: () => object
  }, component: unknown): unknown
}

/** The face the overlay host component receives via the slot's `inject`. */
interface NotifyToastFace {
  queue: ToastQueue
  openSession(sessionId: string): void
}

/** Runtime service lookup: string-keyed `get`, wider than declared names. */
interface NotifyContext extends ClientContext {
  get(name: string): unknown
}

/** A string field read off an owner-defined JSON payload, narrowed. */
function stringField(data: object, key: string): string | undefined {
  if (!(key in data)) return undefined
  const value: unknown = (data as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** Whether one raw event payload carries an assistant message; its text. */
function assistantText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const message = objectField(data, 'message')
  if (message === undefined) return ''
  const contentValue: unknown = 'content' in message ? (message as Record<string, unknown>)['content'] : undefined
  if (typeof contentValue === 'string') return contentValue.trim()
  if (!Array.isArray(contentValue)) return ''
  const parts: string[] = []
  for (const part of contentValue) {
    if (typeof part !== 'object' || part === null) continue
    if (stringField(part, 'type') !== 'text') continue
    const text = stringField(part, 'text')
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** A nested object field read off an owner-defined JSON payload, narrowed. */
function objectField(data: object, key: string): object | undefined {
  if (!(key in data)) return undefined
  const value: unknown = (data as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null ? value : undefined
}

/** Whitespace-collapsed snippet capped for banner display. */
function snippet(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/** The overlay-mounted toast host: renders the queue head, one at a time. */
function NotifyToasts({ queue, openSession }: NotifyToastFace): ReactNode {
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const item = items[0]
  if (item === undefined) return null
  const { sessionId } = item
  const actions = sessionId === undefined ? undefined : [{
    label: 'Open',
    onClick: () => {
      queue.drop(item.id)
      openSession(sessionId)
    },
  }]
  return (
    // The shared banner is body-ported and role="alert"; keying by item id
    // restarts the hold when a newer notice replaces the head.
    <ToastPrimitive
      key={item.id}
      text={item.text}
      holdMs={item.holdMs}
      actions={actions}
      onDone={() => { queue.drop(item.id) }}
    />
  )
}

/**
 * Client plugin body: subscribe to the forwarded session feed, queue toasts,
 * and mount the overlay host. Absent services degrade to a no-op plugin.
 * @param ctx - client root context.
 */
export function apply(ctx: NotifyContext): void {
  const ui = require('@deepseek-ai/dsh-client-ui-primitives') as Partial<UiPrimitives>
  const toast = ui.Toast
  const sessions = tryGet<SessionsFace>(ctx, 'sessions')
  const remote = tryGet<RemoteFace>(ctx, 'remote')
  const slots = tryGet<SlotsFace>(ctx, 'slots')
  if (toast === undefined || remote === undefined || slots === undefined) return

  const queue = new ToastQueue()
  const openSession = (sessionId: string): void => {
    tryGet<{ openSession(target: string): void }>(ctx, 'uiWorkspace')?.openSession(sessionId)
  }
  const face: NotifyToastFace = { queue, openSession }

  /** The user is reading this exact session right now. */
  const activelyViewing = (sessionId: string): boolean => {
    if (document.visibilityState !== 'visible') return false
    const row = sessions?.list.getSnapshot().byId[sessionId]
    return (row?.retainedBy?.mainView ?? 0) > 0
  }

  /** System notification when the tab is hidden and the user opted in. */
  const systemNotify = (item: ToastItem): void => {
    if (!document.hidden || !('Notification' in window)) return
    if (Notification.permission !== 'granted') return
    const notification = new Notification(`dsh — ${item.text}`, { tag: `dsh-notify-${item.sessionId ?? String(item.id)}` })
    notification.onclick = (): void => {
      window.focus()
      if (item.sessionId !== undefined) openSession(item.sessionId)
      notification.close()
      queue.drop(item.id)
    }
  }

  /** Toast unless the user is already reading the session; system-notify when hidden. */
  const announce = (notice: { sessionId: string | undefined; text: string; holdMs: number }): void => {
    if (notice.sessionId !== undefined && activelyViewing(notice.sessionId)) return
    const row = notice.sessionId === undefined ? undefined : sessions?.list.getSnapshot().byId[notice.sessionId]
    const title = row?.displayTitle ?? (notice.sessionId === undefined ? 'dsh' : `Session ${notice.sessionId.slice(0, 8)}`)
    const item = queue.push({ sessionId: notice.sessionId, text: `${title} — ${notice.text}`, holdMs: notice.holdMs })
    systemNotify(item)
  }

  // Request the browser-notification permission lazily, once, on first use —
  // the existing DOM API; no new plumbing. Grant also arms the web-push
  // subscription (same permission on every shipping browser).
  let permissionAsked = false
  const askPermission = (): void => {
    if (permissionAsked || !('Notification' in window)) return
    permissionAsked = true
    if (Notification.permission === 'default') {
      void Notification.requestPermission().then(granted => {
        if (granted === 'granted') void setupPushSubscription(openSession)
      })
    }
  }
  ctx.effect(() => {
    document.addEventListener('pointerdown', askPermission, { once: true, capture: true })
    return () => { document.removeEventListener('pointerdown', askPermission, { capture: true }) }
  }, 'notify: notification permission')

  // Attention reporting: the host suppresses Discord pings only while some
  // page reports focused (heartbeat refreshes the 90s TTL). A backgrounded
  // phone reports unfocused, so the ping still lands. Reports ride
  // keepalive fetches so a page closing while focused releases the gate.
  ctx.effect(() => {
    const pageId = (() => {
      const existing = sessionStorage.getItem('dsh-notify-page-id')
      if (existing !== null) return existing
      const fresh = `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      sessionStorage.setItem('dsh-notify-page-id', fresh)
      return fresh
    })()
    const report = (keepalive: boolean): void => {
      const focused = document.visibilityState === 'visible' && document.hasFocus()
      try {
        void fetch('/api/notify/attention', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, focused }),
          keepalive,
        }).catch(() => {})
      } catch { /* fetch unavailable: the TTL simply expires the report */ }
    }
    report(false)
    const heartbeat = window.setInterval(() => report(false), 60_000)
    const onVisibility = (): void => report(false)
    const onHide = (): void => report(true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.clearInterval(heartbeat)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      onHide()
    }
  }, 'notify: attention reporting')

  ctx.effect(() => {
    const stopStatus = remote.$on('api-session/status', (sessionId, running) => {
      if (running) return
      void announceDone(sessionId)
    })
    // Waterfall observer: never claims; always hands the request to the next
    // answerer (ui-user-questions owns the actual reply card). The forwarded
    // dispatch binds the session scope as `this` (same as ui-user-questions).
    const stopQuestions = remote.$on('user-questions/request', function (request, next) {
      const sessionId = sessions?.scopeOf(this)
      const question = request.questions?.[0]
      const text = [question?.header, question?.question]
        .filter(part => typeof part === 'string' && part.length > 0)
        .join(' — ')
      if (text.length > 0) {
        announce({ sessionId: sessionId ?? undefined, text: `asks: ${snippet(text)}`, holdMs: QUESTION_HOLD_MS })
      }
      return next()
    })
    return () => {
      stopStatus()
      stopQuestions()
    }
  }, 'notify: forwarded feed')

  // Permission already granted (previous visit): arm push right away.
  if ('Notification' in window && Notification.permission === 'granted') {
    void setupPushSubscription(openSession)
  }

  // Deep link from the service worker: a tapped notification focuses the app
  // and opens the session it came from.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null
        && 'type' in data && data.type === 'dsh-notify-open'
        && 'sessionId' in data && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
        openSession(data.sessionId)
      }
    })
  }

  // Mount the overlay host last, so the queue exists before any event lands.
  ctx.effect(() => slots.inject('shell.overlay', () =>
    slots.register({
      name: 'shell.overlay',
      id: 'notify.toast',
      inject: () => face,
    }, NotifyToasts),
  ), 'notify: overlay toasts')

  /** Toast the finished session's final assistant words, when readable. */
  async function announceDone(sessionId: string): Promise<void> {
    // Subagent children relay through their parent; their flips are noise.
    if (sessions?.list.getSnapshot().byId[sessionId]?.origin === 'subagent') return
    if (activelyViewing(sessionId)) return
    const text = await finalAssistantText(sessionId)
    // Nothing readable (empty turn, tool-only work): stay silent.
    if (text.length === 0) return
    announce({ sessionId, text: `finished: ${snippet(text)}`, holdMs: DONE_HOLD_MS })
  }

  /** Last assistant message in the session log, via one passive tail. */
  async function finalAssistantText(sessionId: string): Promise<string> {
    const sessionRemote = tryGet<SessionRemoteFace>(ctx, 'remote.session')
    if (sessionRemote === undefined) return ''
    const controller = new AbortController()
    try {
      const tail = sessionRemote.follow({ address: { kind: 'session', sessionId }, maxMessages: 8 }, controller.signal)
      for await (const frame of tail) {
        if (typeof frame !== 'object' || frame === null) continue
        if (stringField(frame, 'type') !== 'snapshot') continue
        const records: unknown = 'records' in frame ? (frame as Record<string, unknown>)['records'] : undefined
        if (!Array.isArray(records)) break
        for (const record of [...records].reverse()) {
          const event = typeof record === 'object' && record !== null ? objectField(record, 'event') ?? record : undefined
          if (event === undefined || stringField(event, 'type') !== 'assistant/message') continue
          const text = assistantText(objectField(event, 'data'))
          if (text.length > 0) return text
        }
        break
      }
      return ''
    } catch {
      return ''
    } finally {
      controller.abort()
    }
  }
}

/**
 * Register the service worker and arm a web-push subscription for this
 * browser. Fire-and-forget: any failure leaves local toasts + system
 * notifications working; the host Discord channel is unaffected. Requires
 * the deployment to configure `pushPublicKey` (the host route answers
 * `supported: false` otherwise).
 */
async function setupPushSubscription(openSession: (sessionId: string) => void): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) return
    const keyResponse = await fetch('/api/notify/push-key', { headers: { accept: 'application/json' } })
    if (!keyResponse.ok) return
    const keyInfo: unknown = await keyResponse.json()
    if (typeof keyInfo !== 'object' || keyInfo === null
      || !('supported' in keyInfo) || keyInfo.supported !== true
      || !('publicKey' in keyInfo) || typeof keyInfo.publicKey !== 'string' || keyInfo.publicKey.length === 0) {
      return
    }
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    const subscription = (existing !== null && existing.options.applicationServerKey !== undefined
      && bytesToB64Url(new Uint8Array(existing.options.applicationServerKey as ArrayBuffer)) === keyInfo.publicKey)
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(keyInfo.publicKey),
        })
    const response = await fetch('/api/notify/push-subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    if (!response.ok) void subscription.unsubscribe()
  } catch {
    // Push is best-effort; in-page toasts remain the primary surface.
  }
}

/** base64url → bytes for the VAPID applicationServerKey. */
function urlB64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = `${base64Url}${padding}`.replaceAll('-', '+').replaceAll('_', '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/** Bytes → base64url (comparing an existing subscription's key). */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Read a service that may be absent (optional integration points). */
function tryGet<T>(ctx: NotifyContext, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}
