/**
 * The dashboard host service: folds live session usage into the persistent
 * ledger and answers the overview document. Secrets stay in the host
 * process; the browser only ever sees aggregated token counts.
 *
 * Ledger persistence, the atomic-write flush, and the session/event fold
 * (request/header + request/context route attribution, assistant/message
 * usage) are adopted from @linxin666/dsh-usage v0.4.16
 * (`host/usage-service.ts`), Apache License 2.0 — Copyright (c) 2025
 * linxin666 and contributors — reduced to the dashboard's per-session
 * buckets: no provider probes, no credentials, no settings surface.
 * @module dashboard/host/service
 */

import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { createLedgerDocument, deserializeLedger, foldSessionUsage, localDateKey, pruneLedger, type SessionDayTotals, type UsageLedgerDocument } from '../core/ledger.ts'
import { buildOverview, HEATMAP_DAYS, type DashboardOverviewView } from '../core/view.ts'

/** Ledger flush debounce. */
const FLUSH_DEBOUNCE_MS = 3_000

/** Retention: the heatmap's six months plus headroom for older windows. */
const RETAIN_DAYS = HEATMAP_DAYS + 60

/** Provider route a session's model requests run under. */
interface SessionRoute {
  provider: string
  model: string
}

/**
 * Atomic JSON write through a unique temp file + fsync + rename (upstream
 * dsh-usage helper): two overlapping flushes can never interleave into one
 * temp file, and the fsync closes the rename-lands-but-bytes-are-not-durable
 * window.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Normalize a provider TokenUsage into a ledger bucket (one call). */
function totalsFrom(usage: TokenUsage): SessionDayTotals {
  return {
    provider: '', model: '', calls: 1,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    cost: 0,
    firstAt: 0, lastAt: 0,
  }
}

/**
 * The route a request event names. Session event payloads cross the session
 * event union untyped at this boundary (the plugin carries no dsh session
 * type dependency), so each extractor walks the shape with `in`/`typeof`
 * guards and answers undefined for anything else.
 */
function routeOfProviderModel(value: unknown): SessionRoute | undefined {
  if (typeof value !== 'object' || value === null || !('provider' in value)) return undefined
  const provider = value.provider
  if (typeof provider !== 'string' || provider === '') return undefined
  const model = 'model' in value && typeof value.model === 'string' ? value.model : ''
  return { provider, model }
}

function routeOfHeaderEvent(data: unknown): SessionRoute | undefined {
  if (typeof data !== 'object' || data === null || !('header' in data)) return undefined
  const header = data.header
  if (typeof header !== 'object' || header === null || !('config' in header)) return undefined
  return routeOfProviderModel(header.config)
}

function usageOfMessageEvent(data: unknown): TokenUsage | undefined {
  if (typeof data !== 'object' || data === null || !('usage' in data)) return undefined
  const usage = data.usage
  if (typeof usage !== 'object' || usage === null || !('inputTokens' in usage) || !('outputTokens' in usage)) return undefined
  return usage as TokenUsage
}

/** Resolve the DSH home directory the way the host does: env override, then ~/.dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim()
  if (raw !== undefined && raw !== '') {
    return isAbsolute(raw) ? raw : join(process.cwd(), raw)
  }
  return join(homedir(), '.dsh')
}

/**
 * The dashboard service. Owns the live ledger document, its persistence, and
 * the session/event subscription.
 */
export class DashboardService {
  private readonly ctx: Context
  /** Ledger file the service loads and flushes; under DSH_HOME. */
  readonly ledgerPath: string
  private readonly ledger: UsageLedgerDocument = createLedgerDocument()
  /** Per-live-session route attribution (WeakMap: disposed sessions age out). */
  private readonly sessionRoutes = new WeakMap<Session, SessionRoute>()
  private sessionListenerDisposer: (() => void) | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushInFlight: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(ctx: Context, dshHomeDir: string) {
    this.ctx = ctx
    this.ledgerPath = join(dshHomeDir, 'dashboard', 'ledger.json')
  }

  /** Start the session/event subscription and load the persisted ledger. */
  start(): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true })
    this.sessionListenerDisposer = this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    void this.loadPersisted()
  }

  /** Detach, then flush whatever the last folds left behind. */
  stop(): Promise<void> {
    this.disposed = true
    try {
      this.sessionListenerDisposer?.()
    } catch {
      // Fiber already gone during shutdown.
    }
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    return this.flushInFlight.then(() => this.flushNow()).catch(() => {})
  }

  /** The overview document for the dashboard route. */
  overview(): DashboardOverviewView {
    return buildOverview(this.ledger, Date.now())
  }

  // ------------------------------------------------------------------
  // Session usage fold (upstream dsh-usage fold, re-keyed per session)
  // ------------------------------------------------------------------

  private onSessionEvent(session: Session, event: SessionEvent): void {
    try {
      if (event.type === 'request/header') {
        const route = routeOfHeaderEvent(event.data)
        if (route !== undefined) this.sessionRoutes.set(session, route)
      } else if (event.type === 'request/context') {
        const route = routeOfProviderModel(event.data)
        if (route !== undefined) this.sessionRoutes.set(session, route)
      } else if (event.type === 'assistant/message') {
        const usage = usageOfMessageEvent(event.data)
        if (usage === undefined) return
        const route = this.sessionRoutes.get(session)
        if (route === undefined) return
        const totals = totalsFrom(usage)
        totals.provider = route.provider
        totals.model = route.model || 'unknown'
        foldSessionUsage(this.ledger, Date.now(), session.id, totals.provider, totals.model, totals)
        this.scheduleFlush()
      }
    } catch {
      // A malformed event must never break the session loop.
    }
  }

  // ------------------------------------------------------------------
  // Persistence (upstream dsh-usage discipline)
  // ------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.disposed || this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flushInFlight = this.flushInFlight.then(() => this.flushNow()).catch(() => {})
    }, FLUSH_DEBOUNCE_MS)
  }

  private async flushNow(): Promise<void> {
    try {
      pruneLedger(this.ledger, localDateKey(Date.now()), RETAIN_DAYS)
      await writeJsonAtomic(this.ledgerPath, this.ledger)
    } catch {
      // Persistence is best-effort: the next fold retries.
    }
  }

  private async loadPersisted(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8'))
    } catch {
      return
    }
    const loaded = deserializeLedger(parsed)
    // Merge into (never replace) the live document: folds that landed during
    // the read window must survive the load (upstream discipline).
    for (const [dayKey, sessions] of Object.entries(loaded.days)) {
      const atMs = new Date(dayKey + 'T12:00:00').getTime()
      for (const [sessionId, entry] of Object.entries(sessions)) {
        foldSessionUsage(this.ledger, atMs, sessionId, entry.provider, entry.model, { ...entry })
      }
    }
    pruneLedger(this.ledger, localDateKey(Date.now()), RETAIN_DAYS)
  }
}
