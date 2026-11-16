/**
 * The notify watcher: classifies the global session feed into user-attention
 * moments, and schedules a single delayed Discord flush when no remote client
 * is live. Suppression state is one timestamped map plus one timer — no
 * state machine.
 *
 * Notified moments:
 * - `tool/call` naming `ask_user_question` — the agent is blocked on the user.
 * - `turn/end` completed (or max-tokens) whose turn produced a final
 *   assistant message — the agent finished and has something to say.
 *
 * Suppression: at enqueue time and again at send time an *attentive* client
 * gates the send — a page whose latest focus report says focused shows the
 * in-page toast, so Discord stays quiet while dsh is open and on screen;
 * open-but-backgrounded pages never suppress. Without the attention route,
 * the gateway's live-client check is the fallback.
 * @module notify/host/notify
 */

import {
  asAssistantMessage, asTitleEvent, asToolCall, asToolResult, asTurnEnd,
  messageText, type CredentialsFace, type GatewayFace, type LoggerFace,
  type SessionEventLike, type SessionLike,
} from './faces.ts'
import { buildEmbed, sendEmbeds, type NoticeEmbed } from './discord.ts'

/** The ask-user tool name (`ASK_USER_QUESTION_TOOL`, packages/interaction/user-questions). */
const ASK_USER_TOOL = 'ask_user_question'

/** Turn ends that carry a finished say; aborted/blocked/error/forked stay silent. */
const COMPLETED_REASONS = new Set(['completed', 'max-tokens'])

/** Delay bounds applied to the configured delaySeconds. */
const MIN_DELAY_SECONDS = 5
const MAX_DELAY_SECONDS = 3600

/** Age after which per-session scratch entries (final text, titles) expire. */
const SCRATCH_TTL_MS = 6 * 60 * 60 * 1000

/** Age after which a page's focus report is stale and stops suppressing. */
const FOCUS_TTL_MS = 90 * 1000

/** One web page's most recent focus report. */
interface FocusReport {
  focused: boolean
  at: number
}

/** One scheduled, possibly superseded notification. */
interface PendingNotice extends NoticeEmbed {
  /** `tool/call` id when this is a question; its `tool/result` cancels the send. */
  readonly callId: string | undefined
  /** Epoch ms when the delayed flush may send this entry. */
  readonly sendAt: number
}

/** Per-session scratch: the newest assistant text and the newest title. */
interface Scratch {
  readonly at: number
  turn: number
  text: string
  title: string | undefined
}

export interface NotifyOptions {
  readonly enabled: boolean
  readonly delaySeconds: number
  readonly credential: string
  readonly siteUrl: string
}

/** Services notify resolves lazily; any may be absent where it runs. */
export interface NotifyServices {
  readonly gateway: GatewayFace | undefined
  readonly credentials: CredentialsFace | undefined
  readonly advertisedUrl: (() => string) | undefined
  readonly logger: LoggerFace
}

/** Credential refs are POSIX env names; anything else resolves via process env. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export class NotifyService {
  private readonly options: NotifyOptions
  private readonly services: NotifyServices
  private readonly pending = new Map<string, PendingNotice>()
  private readonly scratch = new Map<string, Scratch>()
  /** Focus reports from open web pages, keyed by page id. */
  private readonly attention = new Map<string, FocusReport>()
  /** Whether the attention route is mounted (webServer present). */
  private attentionGateEnabled = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private firstEventSeen = false
  private credentialAbsentLogged = false

  constructor(options: NotifyOptions, services: NotifyServices) {
    this.options = options
    this.services = services
  }

  /** Record one page's focus state (called from the attention route). */
  setAttention(pageId: string, focused: boolean): void {
    const id = pageId.slice(0, 128)
    if (id === '') return
    this.attention.set(id, { focused, at: Date.now() })
  }

  /**
   * Mark the attention gate active: an attention route reports page focus,
   * so suppression keys on focused pages (a backgrounded phone must not
   * silence Discord). Without the route the legacy live-client gate applies.
   */
  enableAttentionGate(): void {
    this.attentionGateEnabled = true
  }

  /**
   * Whether any viewer is actually attending: an open page whose latest
   * focus report (within the TTL) says focused. Stale or unfocused pages
   * never suppress — the Discord ping is the point of a backgrounded dsh.
   */
  private hasAttentiveClient(): boolean {
    if (!this.attentionGateEnabled) {
      return this.services.gateway?.hasLiveClient() === true
    }
    const now = Date.now()
    for (const [pageId, report] of this.attention) {
      if (now - report.at > FOCUS_TTL_MS) this.attention.delete(pageId)
      else if (report.focused) return true
    }
    return false
  }

  /** Clamped delay applied to every send. */
  private get delayMs(): number {
    const seconds = Math.min(Math.max(Math.round(this.options.delaySeconds), MIN_DELAY_SECONDS), MAX_DELAY_SECONDS)
    return seconds * 1000
  }

  /**
   * Register the global feed listeners; returns the disposer.
   * @param register - the host context's event registration, narrowed to the
   *   session feed (`ctx.on`).
   */
  start(register: SessionEventsFace['on']): () => void {
    if (!this.options.enabled) {
      this.services.logger.info('notify: disabled by config')
      return () => {}
    }
    const stopEvents = register('session/event', (session, event) => {
      if (!this.firstEventSeen) {
        this.firstEventSeen = true
        this.services.logger.warn(`notify: feed alive — first session/event "${String(event.type)}" for ${session.id}`)
      }
      try {
        this.onEvent(session, event)
      } catch (error: unknown) {
        this.services.logger.warn('notify: event classification failed:', error)
      }
    }, { global: true })
    const stopDisposed = register('session/disposed', (session) => {
      this.pending.delete(session.id)
      this.scratch.delete(session.id)
    }, { global: true })
    this.services.logger.warn('notify: feed listeners armed (global session/event + session/disposed)')
    return () => {
      stopEvents()
      stopDisposed()
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      this.pending.clear()
      this.scratch.clear()
    }
  }

  // --- classification --------------------------------------------------------

  private onEvent(session: SessionLike, event: SessionEventLike): void {
    // Subagent children relay through their parent session; never notified.
    if (session.header.origin === 'subagent') return
    switch (event.type) {
      case 'session/title': {
        const title = asTitleEvent(event.data)
        if (title !== undefined) this.scratchFor(session.id).title = title.title
        return
      }
      case 'assistant/message': {
        const message = asAssistantMessage(event.data)
        if (message === undefined) return
        const text = messageText(message.message)
        if (text.length === 0) return
        const scratch = this.scratchFor(session.id)
        scratch.at = Date.now()
        scratch.turn = message.turn
        scratch.text = text
        this.pruneScratch(session.id)
        return
      }
      case 'tool/call': {
        const call = asToolCall(event.data)
        if (call === undefined || call.name !== ASK_USER_TOOL) return
        const text = questionSnippet(call.arguments)
        if (text.length === 0) return
        this.enqueue(session, { kind: 'question', sessionId: session.id, title: this.scratch.get(session.id)?.title, cwd: session.header.cwd, text, callId: call.callId })
        return
      }
      case 'tool/result': {
        // The question was answered — the pending Discord ping is obsolete.
        const result = asToolResult(event.data)
        const pending = this.pending.get(session.id)
        if (result !== undefined && pending?.callId === result.callId) this.pending.delete(session.id)
        return
      }
      case 'turn/end': {
        const end = asTurnEnd(event.data)
        if (end === undefined || !COMPLETED_REASONS.has(end.reasonKind)) return
        const scratch = this.scratch.get(session.id)
        if (scratch === undefined || scratch.turn !== end.turn || scratch.text.length === 0) return
        this.enqueue(session, { kind: 'done', sessionId: session.id, title: scratch.title, cwd: session.header.cwd, text: scratch.text, callId: undefined })
        return
      }
      default:
    }
  }

  /** Mutable per-session scratch entry, created on demand. */
  private scratchFor(sessionId: string): Scratch {
    let entry = this.scratch.get(sessionId)
    if (entry === undefined) {
      entry = { at: Date.now(), turn: -1, text: '', title: undefined }
      this.scratch.set(sessionId, entry)
    }
    return entry
  }

  /** Bound the scratch map: drop stale entries once it grows past a page. */
  private pruneScratch(sessionId: string): void {
    if (this.scratch.size < 64) return
    const now = Date.now()
    for (const [id, entry] of this.scratch) {
      if (id !== sessionId && now - entry.at > SCRATCH_TTL_MS) this.scratch.delete(id)
    }
    // Map iteration is insertion-ordered, so this also caps pathological growth.
    while (this.scratch.size > 512) {
      const oldest = this.scratch.keys().next()
      if (oldest.done === true) break
      this.scratch.delete(oldest.value)
    }
  }

  // --- scheduling ------------------------------------------------------------

  /** Store (replacing any prior entry for the session) and arm the flush. */
  private enqueue(session: SessionLike, notice: Omit<PendingNotice, 'sendAt'>): void {
    // An attentive client shows the in-page toast — Discord stays silent.
    if (this.hasAttentiveClient()) {
      this.services.logger.warn(`notify: suppressed ${notice.kind} for ${session.id} — attentive page reported (${String(this.attention.size)} tracked)`)
      return
    }
    this.pending.set(session.id, { ...notice, sendAt: Date.now() + this.delayMs })
    this.arm()
  }

  /** Point the single flush timer at the earliest due entry. */
  private arm(): void {
    let earliest = Infinity
    for (const entry of this.pending.values()) earliest = Math.min(earliest, entry.sendAt)
    if (earliest === Infinity) return
    const wait = Math.max(0, earliest - Date.now())
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, wait)
    this.flushTimer.unref?.()
  }

  /** Send every due entry as one batched webhook call; rearm for the rest. */
  private async flush(): Promise<void> {
    const now = Date.now()
    const due: PendingNotice[] = []
    for (const [id, entry] of this.pending) {
      if (entry.sendAt <= now) {
        due.push(entry)
        this.pending.delete(id)
      }
    }
    if (this.pending.size > 0) this.arm()
    if (due.length === 0) return

    // Re-check before send: a client that subscribed during the delay window
    // cancels the send — the client toast already carried the news.
    if (this.hasAttentiveClient()) {
      this.services.logger.warn(`notify: attentive page appeared during delay; dropped ${String(due.length)} Discord notice(s)`)
      return
    }

    const url = await this.resolveWebhook()
    if (url === undefined) {
      if (!this.credentialAbsentLogged) {
        this.credentialAbsentLogged = true
        this.services.logger.warn(
          `notify: credential "${this.options.credential}" is not configured; Discord notifications stay off`
          + ' (store the webhook URL under a POSIX-name credential ref, or in the service environment)',
        )
      }
      return
    }

    const link = this.deepLink()
    const embeds = due.map(notice => buildEmbed(notice, link))
    await sendEmbeds(url, embeds, this.services.logger)
  }

  /**
   * Resolve the webhook URL per operation (never cached — a rotated credential
   * reaches the next notification). Grammar-valid names go through the
   * credential seam's reference half; other names (e.g. `discord-notify`,
   * which the env-name grammar rejects) fall back to the process environment
   * the same way mcp-manager's envFromProcess feeds a bridge.
   */
  private async resolveWebhook(): Promise<string | undefined> {
    const name = this.options.credential
    if (name.length === 0) return undefined
    if (REF_PATTERN.test(name)) {
      const resolved = await this.services.credentials?.resolve(name)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    }
    const direct = process.env[name]
    return direct !== undefined && direct.length > 0 ? direct : undefined
  }

  /** The web UI's addressable root: configured site, else the advertised URL. */
  private deepLink(): string | undefined {
    const configured = this.options.siteUrl.trim()
    if (configured.length > 0) return configured
    const advertised = this.services.advertisedUrl?.().trim()
    if (advertised !== undefined && advertised.length > 0 && /^https?:\/\//.test(advertised)) return advertised
    return undefined
  }
}

/** First question of an `ask_user_question` arguments blob, as notify text. */
export function questionSnippet(rawArguments: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments) as unknown
  } catch {
    return ''
  }
  if (typeof parsed !== 'object' || parsed === null || !('questions' in parsed)) return ''
  const questions: unknown = (parsed as Record<string, unknown>)['questions']
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const first = questions[0]
  if (typeof first !== 'object' || first === null) return ''
  const parts: string[] = []
  for (const key of ['header', 'question', 'detail'] as const) {
    const value: unknown = key in first ? (first as Record<string, unknown>)[key] : undefined
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value.trim())
  }
  return parts.join(' — ')
}
