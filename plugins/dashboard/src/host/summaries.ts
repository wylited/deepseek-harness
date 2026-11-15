/**
 * The dashboard's idle-summary engine: lazily turns an idle session's recent
 * turns into a two-line status summary through one small auxiliary LLM
 * request (execution mirrors `@deepseek-ai/dsh-session-title-llm`: prepared
 * call on an exact route, bounded input, small output cap, hard deadline,
 * block assembly), caches per session in the ledger document, and answers
 * the dashboard's per-session facts — running state, open user question,
 * cached summary, staleness — without ever making the caller wait for a
 * generation: polls return the cache immediately and kick regeneration in
 * the background.
 *
 * Every integration point (`sessions`, `agents`, `sessionProjections`,
 * `sessionQuery`, `llm`, `agentDefaultModel`) is a soft lookup: absent
 * services degrade to "no pending facts, no generation", never to a failure.
 * @module dashboard/host/summaries
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  cleanSummaryText, composeSummaryInput, fallbackSummary, lastAssistantTextOfEvents,
  pendingOfProjectionValues, SUMMARY_MAX_OUTPUT_TOKENS, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS,
  turnMessagesOfEvents, type DashboardSummaryPending, type DashboardSummaryReport,
  type SessionSummaryEntry,
} from '../core/summary.ts'

/** Route the aux request runs under (provider key + model id). */
interface SummaryRoute {
  provider: string
  model: string
}

/** Cache + activity backing the engine needs from the ledger owner. */
export interface SummaryStore {
  /** The live (mutable) summary map of the ledger document. */
  entries(): Record<string, SessionSummaryEntry>
  /** Persist one fresh entry and schedule the flush. */
  put(sessionId: string, entry: SessionSummaryEntry): void
  /** The session's latest usage fold time (0 when never folded). */
  lastFoldAt(sessionId: string): number
}

/** The minimal aux-call face the engine needs from the `llm` service. */
interface SummaryLlmCall {
  config: {
    provider: string
    model: string
    maxTokens?: number
    reasoningEffort?: string
  }
  stream(options: {
    provider: string
    model: string
    maxTokens?: number
    reasoningEffort?: string
    messages: readonly { role: 'user'; content: readonly { type: 'text'; text: string }[] }[]
    system: string
    sessionId: string
    purpose: string
    signal?: AbortSignal
  }): AsyncIterable<{ type?: string; text?: string }>
}

/** Soft services the engine reads through untyped boundaries (guard-shaped). */
interface SummaryDeps {
  sessions: { get(sessionId: string): unknown } | undefined
  agents: { get(agentId: string): { status?: string } | undefined } | undefined
  projections: { snapshot(session: unknown, keys: { has(key: string): boolean }): unknown } | undefined
  sessionQuery: { observeSession(sessionId: string, options?: { projectionMode?: 'none' }): Promise<unknown> } | undefined
  llm: SummaryLlmCallFace | undefined
  defaultRoute: { currentSelection(): { provider: string; model: string } } | undefined
}

interface SummaryLlmCallFace {
  prepareCall(config: { provider: string; model: string; maxTokens: number }): Promise<SummaryLlmCall>
}

/** One immutable session cut the observation seam hands back (guard-shaped). */
interface ObservedSession {
  events?: readonly unknown[]
  cursor?: number
}

/** Cooldown before a failed generation for one session is retried. */
const RETRY_COOLDOWN_MS = 60_000

/** The projection keys the pending-question read computes. */
const PENDING_KEYS = new Set(['userQuestions'])

/** Safe number read of a session's live log position (the Session.seq). */
function liveSeqOf(session: unknown): number | undefined {
  if (typeof session !== 'object' || session === null || !('seq' in session)) return undefined
  const seq: unknown = session.seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : undefined
}

/** Soft service read; cordis `get` answers undefined when never provided. */
function softGet(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * The idle-summary engine. One instance per dashboard service; methods are
 * synchronous unless generating.
 */
export class SummaryEngine {
  private readonly deps: SummaryDeps
  /** The route each live session last ran under (owned by the ledger fold). */
  private readonly routeOfSession: (session: Session) => SummaryRoute | undefined
  /** Single-flight generations and failure cooldowns, per session id. */
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly retryAfter = new Map<string, number>()
  private readonly generationSignals = new Set<AbortController>()
  private disposed = false

  constructor(ctx: Context, routeOfSession: (session: Session) => SummaryRoute | undefined) {
    this.deps = {
      sessions: softGet(ctx, 'sessions') as SummaryDeps['sessions'],
      agents: softGet(ctx, 'agents') as SummaryDeps['agents'],
      projections: softGet(ctx, 'sessionProjections') as SummaryDeps['projections'],
      sessionQuery: softGet(ctx, 'sessionQuery') as SummaryDeps['sessionQuery'],
      llm: softGet(ctx, 'llm') as SummaryDeps['llm'],
      defaultRoute: softGet(ctx, 'agentDefaultModel') as SummaryDeps['defaultRoute'],
    }
    this.routeOfSession = routeOfSession
  }

  /** Abort in-flight generations; the route answers stop() at shutdown. */
  dispose(): void {
    this.disposed = true
    for (const controller of this.generationSignals) controller.abort()
    this.generationSignals.clear()
  }

  /**
   * Report the requested sessions' facts. Regeneration for stale idle
   * sessions starts here and never blocks the answer.
   */
  poll(sessionIds: readonly string[], store: SummaryStore): DashboardSummaryReport[] {
    const now = Date.now()
    const entries = store.entries()
    const reports: DashboardSummaryReport[] = []
    for (const sessionId of sessionIds) {
      const live = this.deps.sessions?.get(sessionId)
      const running = this.deps.agents?.get(sessionId)?.status === 'running'
      const pending = this.pendingOf(live)
      const entry = entries[sessionId]
      const liveSeq = liveSeqOf(live)
      const stale = entry === undefined
        || (liveSeq !== undefined ? entry.asOfSeq < liveSeq : entry.atMs < store.lastFoldAt(sessionId))
      if (!running && stale && (this.retryAfter.get(sessionId) ?? 0) <= now && !this.inFlight.has(sessionId)) {
        this.generate(sessionId, store)
      }
      reports.push({
        sessionId,
        running,
        pending,
        summary: entry?.text,
      })
    }
    return reports
  }

  /** The open user question of a live session, from its projection snapshot. */
  private pendingOf(live: unknown): DashboardSummaryPending | undefined {
    if (live === undefined || this.deps.projections === undefined) return undefined
    try {
      const snapshot: unknown = this.deps.projections.snapshot(live, PENDING_KEYS)
      if (typeof snapshot !== 'object' || snapshot === null || !('values' in snapshot)) return undefined
      const values: unknown = snapshot.values
      if (typeof values !== 'object' || values === null) return undefined
      return pendingOfProjectionValues(values as Record<string, unknown>)
    } catch {
      // A failing projection read serves no pending fact; the client's own
      // list projections remain the fallback source.
      return undefined
    }
  }

  /** The aux route: the session's own last route, else the default selection. */
  private routeOf(live: unknown): SummaryRoute | undefined {
    if (live !== undefined) {
      const captured = this.routeOfSession(live as Session)
      if (captured !== undefined && captured.provider !== '' && captured.model !== '') return captured
    }
    try {
      const selection = this.deps.defaultRoute?.currentSelection()
      if (selection !== undefined && selection.provider !== '' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // No default selection mounted; generation degrades to the fallback.
    }
    return undefined
  }

  /** Fire-and-forget regeneration; failures arm the retry cooldown. */
  private generate(sessionId: string, store: SummaryStore): void {
    if (this.disposed) return
    const generation = this.runGeneration(sessionId, store)
      .catch(() => {})
      .finally(() => { this.inFlight.delete(sessionId) })
    this.inFlight.set(sessionId, generation)
  }

  private async runGeneration(sessionId: string, store: SummaryStore): Promise<void> {
    const controller = new AbortController()
    this.generationSignals.add(controller)
    const deadline = AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    deadline.addEventListener('abort', onAbort, { once: true })
    try {
      const observed = await this.observe(sessionId)
      if (observed === undefined) {
        this.retryAfter.set(sessionId, Date.now() + RETRY_COOLDOWN_MS)
        return
      }
      const messages = turnMessagesOfEvents(observed.events ?? [])
      let text: string | undefined
      const live = this.deps.sessions?.get(sessionId)
      const route = this.routeOf(live)
      if (route !== undefined && this.deps.llm !== undefined && messages.length > 0) {
        text = await this.complete(this.deps.llm, route, sessionId, messages, controller.signal)
      }
      if (text === undefined) {
        text = fallbackSummary(lastAssistantTextOfEvents(observed.events ?? []))
        if (text === undefined) {
          // Nothing readable at all: cooldown instead of polling hot.
          this.retryAfter.set(sessionId, Date.now() + RETRY_COOLDOWN_MS)
          return
        }
      }
      this.retryAfter.delete(sessionId)
      // The live log position at generation time: the poll compares it
      // against `session.seq` (the next position), so a session that has
      // seen no new events never reads stale. Cold generations fall back
      // to the observation cursor (last index) and re-check via atMs.
      const liveSeq = liveSeqOf(live)
      store.put(sessionId, {
        text,
        asOfSeq: liveSeq ?? (typeof observed.cursor === 'number' && Number.isFinite(observed.cursor) ? observed.cursor : -1),
        atMs: Date.now(),
      })
    } finally {
      deadline.removeEventListener('abort', onAbort)
      this.generationSignals.delete(controller)
    }
  }

  /**
   * One exact session cut through the session-query seam (live-preferred,
   * revision-cached cold reads); undefined when the seam is not mounted or
   * the session is unreadable.
   */
  private async observe(sessionId: string): Promise<ObservedSession | undefined> {
    if (this.deps.sessionQuery === undefined) return undefined
    try {
      const observation: unknown = await this.deps.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      if (typeof observation !== 'object' || observation === null) return undefined
      return observation as ObservedSession
    } catch {
      return undefined
    }
  }

  /**
   * One aux completion: prepared call on the exact route, two-line system
   * contract, bounded transcript, assembled text. Any failure returns
   * undefined (the caller falls back deterministically).
   */
  private async complete(
    llm: SummaryLlmCallFace,
    route: SummaryRoute,
    sessionId: string,
    messages: readonly { role: 'user' | 'assistant'; text: string }[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const call = await llm.prepareCall({
        provider: route.provider,
        model: route.model,
        maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      })
      signal.throwIfAborted()
      const assembler: string[] = []
      const stream = call.stream({
        provider: call.config.provider,
        model: call.config.model,
        maxTokens: call.config.maxTokens,
        reasoningEffort: call.config.reasoningEffort,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: composeSummaryInput(messages) }],
        }],
        system: SUMMARY_SYSTEM,
        sessionId,
        purpose: 'dashboard-summary',
        signal,
      })
      for await (const chunk of stream) {
        signal.throwIfAborted()
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') assembler.push(chunk.text)
      }
      signal.throwIfAborted()
      const text = cleanSummaryText(assembler.join(''))
      return text === '' ? undefined : text
    } catch {
      return undefined
    }
  }
}
