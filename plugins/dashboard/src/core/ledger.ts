/**
 * The dashboard usage ledger: a pure fold from session usage facts into a
 * per-day, per-session, per-model totals document, plus its JSON
 * (de)serialization and retention pruning.
 *
 * Forked from @linxin666/dsh-usage (packages `core/ledger.ts`, v0.4.16),
 * Apache License 2.0 — Copyright (c) 2025 linxin666 and contributors — with
 * the per-provider/per-model bucketing re-keyed to per-session/per-model so
 * the dashboard can show what each agent consumed. The fold semantics, the
 * prototype-pollution bucket guard, the revive-on-load strictness, and the
 * day-key helpers are the upstream implementation.
 * @module dashboard/core/ledger
 */

/** One per-session day bucket: what that session consumed that local day. */
export interface SessionDayTotals {
  /** Provider route key (e.g. `zai`, `zcode`). */
  provider: string
  /** Provider-owned model id the steps ran under. */
  model: string
  /** Completed model requests folded into this bucket. */
  calls: number
  /** Uncached input tokens. */
  inputTokens: number
  /** Output tokens (reasoning tokens ride inside output for billing). */
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Reported reasoning token count, informational. */
  reasoningTokens: number
  /** Estimated cost in CNY; 0 while no price table covers the route. */
  cost: number
  /** Epoch ms of the first fold into this bucket that local day. */
  firstAt: number
  /** Epoch ms of the latest fold into this bucket that local day. */
  lastAt: number
}

/** The persisted ledger document: local day → session id → bucket. */
export interface UsageLedgerDocument {
  version: 1
  days: Record<string, Record<string, SessionDayTotals>>
}

/** An empty ledger document. */
export function createLedgerDocument(): UsageLedgerDocument {
  return { version: 1, days: {} }
}

/** Local-date key (`YYYY-MM-DD`) for an epoch ms timestamp. */
export function localDateKey(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Whether a string is a real local calendar date key (`YYYY-MM-DD`). */
export function isLedgerDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const atMs = new Date(key + 'T12:00:00').getTime()
  return Number.isFinite(atMs) && localDateKey(atMs) === key
}

/**
 * Bucket keys come from untrusted directions (persisted JSON, session ids
 * out of session events), so they must never collide with
 * `Object.prototype` plumbing: assigning `day['__proto__']` or reading
 * `day['constructor']` would pollute every object in the host process.
 * (Upstream dsh-usage guard, same rationale.)
 */
function isSafeBucketKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/** An all-zero totals bucket. */
export function emptyTotals(): SessionDayTotals {
  return {
    provider: '', model: '', calls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, cost: 0, firstAt: 0, lastAt: 0,
  }
}

/** Accumulate `add` into `into` in place (except firstAt/lastAt, caller-owned). */
export function addTotals(into: SessionDayTotals, add: Readonly<SessionDayTotals>): SessionDayTotals {
  into.calls += add.calls
  into.inputTokens += add.inputTokens
  into.outputTokens += add.outputTokens
  into.cacheReadTokens += add.cacheReadTokens
  into.cacheWriteTokens += add.cacheWriteTokens
  into.reasoningTokens += add.reasoningTokens
  into.cost += add.cost
  return into
}

/**
 * Fold one session usage report into the ledger in place. `provider` is the
 * route key and `model` the provider-owned model id the step ran under.
 * Reports keyed by prototype-plumbing names are dropped; empty reports are
 * dropped so a persisted-but-usage-less request never mints a day bucket.
 */
export function foldSessionUsage(
  doc: UsageLedgerDocument,
  atMs: number,
  sessionId: string,
  provider: string,
  model: string,
  usage: Readonly<SessionDayTotals>,
): void {
  if (!isSafeBucketKey(sessionId)) return
  if (usage.calls <= 0 && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return
  const dayKey = localDateKey(atMs)
  const day = doc.days[dayKey] ?? {}
  const bucket = day[sessionId] ?? emptyTotals()
  const firstAt = bucket.firstAt === 0 ? atMs : Math.min(bucket.firstAt, atMs)
  addTotals(bucket, usage)
  bucket.provider = usage.provider || bucket.provider
  bucket.model = usage.model || bucket.model
  bucket.firstAt = firstAt
  bucket.lastAt = Math.max(bucket.lastAt, atMs)
  day[sessionId] = bucket
  doc.days[dayKey] = day
}

/** Total tokens of a bucket (billed input + output; reasoning is inside output). */
export function totalTokens(totals: Readonly<SessionDayTotals>): number {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/** All local-date keys in the ledger, ascending. */
export function ledgerDayKeys(doc: Readonly<UsageLedgerDocument>): string[] {
  return Object.keys(doc.days).sort()
}

/**
 * Drop every day older than `retainDays` local days before `todayKey`, in
 * place. Returns the number of pruned days.
 */
export function pruneLedger(doc: UsageLedgerDocument, todayKey: string, retainDays: number): number {
  const cutoff = new Date(todayKey + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - retainDays)
  const cutoffKey = localDateKey(cutoff.getTime())
  let pruned = 0
  for (const key of Object.keys(doc.days)) {
    if (key < cutoffKey) {
      delete doc.days[key]
      pruned += 1
    }
  }
  return pruned
}

function reviveTotals(value: unknown, provider: string, model: string, atMs: number): SessionDayTotals | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const num = (key: string): number => typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : 0
  return {
    provider,
    model,
    calls: num('calls'),
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadTokens: num('cacheReadTokens'),
    cacheWriteTokens: num('cacheWriteTokens'),
    reasoningTokens: num('reasoningTokens'),
    cost: num('cost'),
    firstAt: num('firstAt') || atMs,
    lastAt: num('lastAt') || atMs,
  }
}

/**
 * Parse a ledger document from untrusted JSON: unknown shapes resolve to an
 * empty document, malformed entries are dropped, numbers are coerced to
 * finite values. Never throws. (Upstream dsh-usage revive discipline.)
 */
export function deserializeLedger(value: unknown): UsageLedgerDocument {
  const doc = createLedgerDocument()
  if (typeof value !== 'object' || value === null) return doc
  const days = (value as Record<string, unknown>).days
  if (typeof days !== 'object' || days === null) return doc
  for (const [dateKey, sessions] of Object.entries(days as Record<string, unknown>)) {
    if (!isLedgerDateKey(dateKey) || typeof sessions !== 'object' || sessions === null) continue
    const atMs = new Date(dateKey + 'T12:00:00').getTime()
    for (const [sessionId, entry] of Object.entries(sessions as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const provider = typeof entry.provider === 'string' ? entry.provider : ''
      const model = typeof entry.model === 'string' ? entry.model : ''
      const revived = reviveTotals(entry, provider, model, atMs)
      if (revived !== undefined) foldSessionUsage(doc, atMs, sessionId, provider, model, revived)
    }
  }
  return doc
}
