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
 * When the deployment serves a VAPID key, the same overlay also hosts a push
 * chip: while phone push is not active it offers to enable it (an explicit
 * click — the only place permission is ever requested from, since a
 * document-wide pointerdown never qualified as a user gesture on Firefox),
 * it names a blocked permission instead of hiding it, and it reports every
 * subscribe failure with its reason.
 *
 * Host events are consumed through the forwarded feed only (`ctx.remote.$on`),
 * so this half never polls: `api-session/status` running→false announces a
 * finished turn, and the `user-questions/request` waterfall (always delegated
 * with `next()`) announces a pending question without touching the answerer.
 * @module notify/client
 */

import { useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
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

/** Push chip states; `hidden` and `ready` render nothing. */
type PushStatus =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'offer' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'error'; readonly reason: string }

/** Snapshot the chip subscribes to. */
interface PushSnapshot {
  readonly status: PushStatus
  readonly dismissed: boolean
}

/** Terminal report of one subscribe attempt. `unsupported` marks an
 * environment that can never push: the chip hides instead of nagging. */
interface PushOutcome {
  readonly ok: boolean
  readonly unsupported: boolean
  readonly reason: string
}

/** The face the overlay-mounted push chip receives via the slot's `inject`. */
interface NotifyPushFace {
  store: PushChipStore
  enable(): void
  dismiss(): void
}

class PushChipStore {
  private status: PushStatus = { kind: 'hidden' }
  private dismissed = false
  private snapshot: PushSnapshot = { status: { kind: 'hidden' }, dismissed: false }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Cached: `useSyncExternalStore` loops forever on a fresh object per call. */
  getSnapshot = (): PushSnapshot => this.snapshot

  /** Enter a state; a kind change re-arms a chip the user dismissed. */
  set(status: PushStatus): void {
    if (status.kind === this.status.kind && status.kind !== 'error') return
    if (status.kind === 'error' && this.status.kind === 'error' && this.status.reason === status.reason) return
    if (status.kind !== this.status.kind) this.dismissed = false
    this.status = status
    this.changed()
  }

  dismiss(): void {
    if (this.dismissed) return
    this.dismissed = true
    this.changed()
  }

  /**
   * Reconcile the chip with the browser permission while it idles on an
   * offer/denied/error state — the path of a user who enabled the site in
   * browser settings and came back. Returns 'arm' when the permission is now
   * granted and the subscription is not known-good; the caller then runs the
   * subscribe pipeline silently.
   */
  syncPermission(): 'arm' | 'none' {
    if (!('Notification' in window)) return 'none'
    const kind = this.status.kind
    if (kind !== 'offer' && kind !== 'denied' && kind !== 'error') return 'none'
    const permission = Notification.permission
    if (permission === 'denied') {
      this.set({ kind: 'denied' })
      return 'none'
    }
    if (permission === 'default') {
      this.set({ kind: 'offer' })
      return 'none'
    }
    return 'arm'
  }

  private changed(): void {
    this.snapshot = { status: this.status, dismissed: this.dismissed }
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
 * The shell-overlay push chip. Visible exactly while phone push is not
 * active and the environment supports it: an offer to enable, the blocked
 * permission spelled out (a Firefox profile that once denied can only
 * recover through browser settings — the chip is where that is said), or
 * the reason a subscribe attempt failed. `hidden`/`ready`/dismissed render
 * nothing.
 */
function NotifyPushChip({ store, enable, dismiss }: NotifyPushFace): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { status, dismissed } = snapshot
  if (dismissed || status.kind === 'hidden' || status.kind === 'ready') return null
  const copy = status.kind === 'offer' ? 'Enable phone push'
    : status.kind === 'busy' ? 'Enabling phone push…'
    : status.kind === 'denied' ? 'Push blocked — allow notifications for this site in browser settings'
    : `Phone push failed — ${status.reason}`
  return (
    <div style={CHIP_STYLE} data-dsh-notify-push>
      <span style={CHIP_TEXT}>{copy}</span>
      {(status.kind === 'offer' || status.kind === 'error') && (
        <button type="button" style={CHIP_ACTION} onClick={enable}>
          {status.kind === 'offer' ? 'Enable' : 'Retry'}
        </button>
      )}
      {status.kind !== 'busy' && (
        <button type="button" style={CHIP_DISMISS} aria-label="Dismiss" title="Dismiss" onClick={dismiss}>×</button>
      )}
    </div>
  )
}

/** Chip surface: the shared toast material (dark in both themes), anchored
 * bottom-right inside the frame-wide overlay layer, clear of the top-center
 * toast banner. */
const CHIP_STYLE: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  bottom: 'max(16px, env(safe-area-inset-bottom))',
  zIndex: 1,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  boxSizing: 'border-box',
  width: 'max-content',
  maxWidth: 'min(360px, calc(100vw - 32px))',
  padding: '10px 12px',
  borderRadius: 'var(--dsw-radius-lg, 16px)',
  background: 'var(--dsw-alias-toast-bg, rgba(23, 26, 38, 0.96))',
  color: 'var(--dsw-alias-toast-label, rgb(240, 242, 245))',
  fontSize: 13,
  lineHeight: '20px',
  boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.24))',
  pointerEvents: 'auto',
}

const CHIP_TEXT: CSSProperties = { minWidth: 0 }

/** Action text: the toast action's deepseek blue, same no-underline idiom. */
const CHIP_ACTION: CSSProperties = {
  flex: 'none',
  padding: 0,
  border: 0,
  background: 'none',
  color: 'var(--dsw-static-deepseek-400, rgb(77, 133, 247))',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}

const CHIP_DISMISS: CSSProperties = {
  flex: 'none',
  padding: 0,
  border: 0,
  background: 'none',
  color: 'var(--dsw-alias-label-secondary, rgb(160, 166, 178))',
  fontSize: 15,
  lineHeight: '20px',
  cursor: 'pointer',
}

/**
 * Client plugin body: subscribe to the forwarded session feed, queue toasts,
 * and mount the overlay host. Absent services degrade to a no-op plugin.
 * @param ctx - client root context.
 */
/** Faces {@link apply} needs; without this declaration the module system hands
 * `apply` a context with no services and it silently degrades to a no-op. */
export const inject = ['sessions', 'remote', 'slots', 'uiWorkspace']

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

  // Phone push. Permission is requested only from the chip's own click: the
  // previous document-wide `pointerdown` auto-request ran once, was not
  // honored as a user gesture on Firefox (its prompt never appears), and
  // left denied or dismissed profiles silent forever.
  const push = new PushChipStore()

  /** Background arm (permission already granted): silent success, the chip
   * carries the reason on failure. */
  const armPush = (): void => {
    void subscribePush(push).then(outcome => {
      if (outcome.ok) push.set({ kind: 'ready' })
      else if (!outcome.unsupported) push.set({ kind: 'error', reason: outcome.reason })
    })
  }

  /** The chip's Enable/Retry: ask inside the click's user gesture (Firefox
   * requires it), then subscribe and POST, toasting the outcome. */
  const enablePush = (): void => {
    if (push.getSnapshot().status.kind === 'busy') return
    push.set({ kind: 'busy' })
    const run = (): void => {
      void subscribePush(push).then(outcome => {
        if (outcome.ok) {
          push.set({ kind: 'ready' })
          queue.push({ sessionId: undefined, text: 'Phone push enabled', holdMs: DONE_HOLD_MS })
        } else if (!outcome.unsupported) {
          push.set({ kind: 'error', reason: outcome.reason })
          queue.push({ sessionId: undefined, text: `Phone push failed — ${outcome.reason}`, holdMs: QUESTION_HOLD_MS })
        }
      })
    }
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().then(permission => {
        if (permission === 'granted') run()
        else push.set(permission === 'denied' ? { kind: 'denied' } : { kind: 'offer' })
      }, (error: unknown) => {
        push.set({ kind: 'error', reason: pushErrorReason(error) })
      })
    } else {
      run()
    }
  }

  const pushFace: NotifyPushFace = { store: push, enable: enablePush, dismiss: (): void => push.dismiss() }

  // Probe once per page load: without a served VAPID key (or with a dead
  // endpoint) this deployment has no push channel at all and the chip stays
  // hidden. Otherwise surface the current permission state, and arm right
  // away when a previous visit already granted it.
  ctx.effect(() => {
    void pushKey().then(key => {
      if (!key.supported || !('Notification' in window)) {
        push.set({ kind: 'hidden' })
        return
      }
      const permission = Notification.permission
      if (permission === 'denied') push.set({ kind: 'denied' })
      else if (permission === 'default') push.set({ kind: 'offer' })
      else armPush()
    }, (error: unknown) => {
      pushLog('warn', `push-key probe failed: ${pushErrorReason(error)}`)
      push.set({ kind: 'hidden' })
    })
  }, 'notify: push probe')

  // Returning to the tab re-reads the permission: a user who allowed the
  // site in browser settings comes back to an armed subscription without a
  // reload, and a re-blocked one sees the chip say so.
  ctx.effect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (push.syncPermission() === 'arm') armPush()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, 'notify: push permission watch')

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

  // The push chip mounts beside the toasts on the same frame-wide overlay.
  ctx.effect(() => slots.inject('shell.overlay', () =>
    slots.register({
      name: 'shell.overlay',
      id: 'notify.push',
      inject: () => pushFace,
    }, NotifyPushChip),
  ), 'notify: push chip')

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

/** Client push log: the browser half has no logger service, so a clear
 * prefix keeps these greppable beside the host's `[connection]` style. */
function pushLog(level: 'info' | 'warn', message: string): void {
  if (level === 'warn') console.warn(`[notify] push: ${message}`)
  else console.info(`[notify] push: ${message}`)
}

/** One-sentence, jargon-light reason for a failed subscribe step. */
function pushErrorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name: unknown = error.name
    if (name === 'NotAllowedError') return 'the browser denied the subscription'
    if (name === 'InvalidStateError') return 'a stale subscription is in the way — reload the page and retry'
    if (name === 'AbortError') return 'the browser cancelled the subscription'
  }
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

/** An environment that can never push: log it and hide the chip. */
function pushUnsupported(reason: string): PushOutcome {
  pushLog('warn', `push unavailable: ${reason}`)
  return { ok: false, unsupported: true, reason }
}

/** GET /api/notify/push-key for this page. One probe per load; a rejection
 * clears itself so a later Enable/Retry probes a server that came back. */
type PushKeyInfo = { readonly supported: false } | { readonly supported: true; readonly publicKey: string }

let pushKeyQuery: Promise<PushKeyInfo> | undefined

function pushKey(): Promise<PushKeyInfo> {
  if (pushKeyQuery === undefined) {
    pushKeyQuery = (async () => {
      const response = await fetch('/api/notify/push-key', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`push-key answered HTTP ${String(response.status)}`)
      const info: unknown = await response.json()
      if (typeof info !== 'object' || info === null
        || !('supported' in info) || info.supported !== true
        || !('publicKey' in info) || typeof info.publicKey !== 'string' || info.publicKey.length === 0) {
        return { supported: false } satisfies PushKeyInfo
      }
      return { supported: true, publicKey: info.publicKey }
    })().catch((error: unknown) => {
      pushKeyQuery = undefined
      throw error
    })
  }
  return pushKeyQuery
}

/**
 * Register the service worker and arm this browser's web-push subscription,
 * reusing an existing one that already names the server's current VAPID key.
 * No dead end is silent: every failure logs and reports a reason, and an
 * `unsupported` outcome (no Push API, insecure origin, no server key) tells
 * the caller to hide the chip instead of nagging. A subscription the server
 * refuses is dropped, so no endpoint receives pushes nobody reads.
 * @param store - chip state the outcome reports into.
 * @returns ok on a delivered subscription, otherwise why not.
 */
async function subscribePush(store: PushChipStore): Promise<PushOutcome> {
  try {
    if (!('serviceWorker' in navigator)) return pushUnsupported('this browser has no service worker support')
    if (!('PushManager' in window)) return pushUnsupported('this browser has no Push API')
    if (!('Notification' in window)) return pushUnsupported('this browser has no Notification API')
    if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      return pushUnsupported('web push needs a secure (https) origin')
    }
    const key = await pushKey()
    if (!key.supported) return pushUnsupported('the server has no VAPID push key configured')
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    // Firefox exposes no applicationServerKey on the options, so the
    // comparison fails there and subscribe runs again; the browser folds
    // that into the existing subscription.
    const subscription = (existing !== null && existing.options.applicationServerKey !== undefined
      && bytesToB64Url(new Uint8Array(existing.options.applicationServerKey as ArrayBuffer)) === key.publicKey)
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(key.publicKey),
        })
    const response = await fetch('/api/notify/push-subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    if (!response.ok) {
      void subscription.unsubscribe().catch((error: unknown) => {
        pushLog('warn', `unsubscribe after rejected POST: ${pushErrorReason(error)}`)
      })
      return { ok: false, unsupported: false, reason: `the server refused the subscription (HTTP ${String(response.status)})` }
    }
    pushLog('info', 'subscription delivered')
    return { ok: true, unsupported: false, reason: '' }
  } catch (error) {
    const reason = pushErrorReason(error)
    pushLog('warn', `subscribe failed: ${reason}`)
    return { ok: false, unsupported: false, reason }
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
