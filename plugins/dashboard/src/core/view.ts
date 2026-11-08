/**
 * The overview view: pure aggregation from the ledger document into the one
 * compact document the dashboard route serves and the browser renders.
 * Sized for a personal dashboard — no hourly rollups, just local days,
 * trailing windows, and per-model/per-session leaderboards.
 *
 * Rollup spirit (per-day aggregates, trailing-window totals) follows
 * oh-my-pi's stats plugin; the implementation is this plugin's own, with the
 * day-bucket shape forked from @linxin666/dsh-usage (Apache-2.0).
 * @module dashboard/core/view
 */

import {
  ledgerDayKeys, localDateKey,
  totalTokens, type UsageLedgerDocument,
} from './ledger.ts'

/** How many local days the heatmap grid covers (a full trailing year). */
export const HEATMAP_DAYS = 365

/** How many local days the bar chart covers. */
export const BARS_DAYS = 30

/** Trailing windows the headline numbers aggregate (local days, including today). */
export const WEEK_DAYS = 7

/** Hard cap on the recent-sessions rows the overview serves. */
export const RECENT_SESSION_CAP = 12

/** Aggregated token/call/session/cost figures over a set of days. */
export interface UsageWindowTotals {
  tokens: number
  calls: number
  /** Distinct session ids seen across the window's days. */
  sessions: number
  cost: number
}

/** One heatmap/bars day row. */
export interface UsageDayPoint {
  date: string
  tokens: number
  calls: number
  sessions: number
}

/** One per-model leaderboard row. */
export interface UsageModelRow {
  provider: string
  model: string
  tokens: number
  calls: number
  cost: number
}

/** One per-session row across the trailing window. */
export interface UsageSessionRow {
  sessionId: string
  provider: string
  model: string
  tokens: number
  calls: number
  cost: number
  /** Epoch ms of the session's latest fold in the window. */
  lastAt: number
}

/** The document GET /api/dashboard/overview answers with. */
export interface DashboardOverviewView {
  generatedAt: number
  today: UsageWindowTotals
  week: UsageWindowTotals
  month: UsageWindowTotals
  allTime: UsageWindowTotals & { firstDay?: string }
  /** Ascending, exactly HEATMAP_DAYS entries (leading zero days before the ledger starts). */
  heatmapDays: UsageDayPoint[]
  /** Ascending, exactly BARS_DAYS entries (leading zero days before the ledger starts). */
  bars30: UsageDayPoint[]
  /** Trailing-30-day per-model rows, heaviest first. */
  models30: UsageModelRow[]
  /** Trailing-30-day per-session rows, most recent first. */
  sessionsRecent: UsageSessionRow[]
}

/** Local date keys for the `count` days ending at (and including) `todayKey`. */
export function trailingDayKeys(todayKey: string, count: number): string[] {
  const end = new Date(todayKey + 'T12:00:00').getTime()
  const keys: string[] = []
  for (let index = count - 1; index >= 0; index -= 1) {
    keys.push(localDateKey(end - index * 86_400_000))
  }
  return keys
}

/** Aggregate the given ledger days into window totals. */
export function summarizeWindow(
  doc: Readonly<UsageLedgerDocument>,
  dayKeys: readonly string[],
): UsageWindowTotals {
  const seen = new Set<string>()
  const totals: UsageWindowTotals = { tokens: 0, calls: 0, sessions: 0, cost: 0 }
  for (const key of dayKeys) {
    const day = doc.days[key]
    if (day === undefined) continue
    for (const [sessionId, bucket] of Object.entries(day)) {
      totals.tokens += totalTokens(bucket)
      totals.calls += bucket.calls
      totals.cost += bucket.cost
      seen.add(sessionId)
    }
  }
  totals.sessions = seen.size
  return totals
}

/** Aggregate one ledger day into a point row. */
export function dayPoint(doc: Readonly<UsageLedgerDocument>, dateKey: string): UsageDayPoint {
  const day = doc.days[dateKey]
  if (day === undefined) return { date: dateKey, tokens: 0, calls: 0, sessions: 0 }
  let tokens = 0
  let calls = 0
  for (const bucket of Object.values(day)) {
    tokens += totalTokens(bucket)
    calls += bucket.calls
  }
  return { date: dateKey, tokens, calls, sessions: Object.keys(day).length }
}

/** Aggregate one ledger day per model (not capped — callers cap for display). */
export function dayModelRows(doc: Readonly<UsageLedgerDocument>, dateKey: string): UsageModelRow[] {
  const day = doc.days[dateKey]
  if (day === undefined) return []
  const merged = new Map<string, UsageModelRow>()
  for (const bucket of Object.values(day)) {
    const key = `${bucket.provider}\u0000${bucket.model}`
    const row = merged.get(key) ?? { provider: bucket.provider, model: bucket.model, tokens: 0, calls: 0, cost: 0 }
    row.tokens += totalTokens(bucket)
    row.calls += bucket.calls
    row.cost += bucket.cost
    merged.set(key, row)
  }
  return [...merged.values()]
}

/** Aggregate one ledger day per session, keeping each session's latest fold time. */
export function daySessionRows(doc: Readonly<UsageLedgerDocument>, dateKey: string): UsageSessionRow[] {
  const day = doc.days[dateKey]
  if (day === undefined) return []
  return Object.entries(day).map(([sessionId, bucket]) => ({
    sessionId,
    provider: bucket.provider,
    model: bucket.model,
    tokens: totalTokens(bucket),
    calls: bucket.calls,
    cost: bucket.cost,
    lastAt: bucket.lastAt,
  }))
}

/**
 * Merge per-day session rows that share a session id: tokens/calls add,
 * model fields follow the latest activity, lastAt is the max.
 */
export function mergeSessionRows(rows: ReadonlyArray<UsageSessionRow>): UsageSessionRow[] {
  const merged = new Map<string, UsageSessionRow>()
  for (const row of rows) {
    const existing = merged.get(row.sessionId)
    if (existing === undefined) {
      merged.set(row.sessionId, { ...row })
      continue
    }
    existing.tokens += row.tokens
    existing.calls += row.calls
    existing.cost = (existing.cost ?? 0) + (row.cost ?? 0)
    if (row.lastAt > existing.lastAt) {
      existing.lastAt = row.lastAt
      existing.provider = row.provider
      existing.model = row.model
    }
  }
  return [...merged.values()]
}

/**
 * Build the overview view. Pure: reads the document, allocates fresh rows.
 */
export function buildOverview(doc: Readonly<UsageLedgerDocument>, nowMs: number): DashboardOverviewView {
  const todayKey = localDateKey(nowMs)
  const trailing = trailingDayKeys(todayKey, HEATMAP_DAYS)
  const weekKeys = trailing.slice(HEATMAP_DAYS - WEEK_DAYS)
  const monthKeys = trailing.slice(HEATMAP_DAYS - BARS_DAYS)

  const monthRows = mergeSessionRows(monthKeys.flatMap(key => daySessionRows(doc, key)))
  monthRows.sort((a, b) => b.lastAt - a.lastAt)

  const models = new Map<string, UsageModelRow>()
  for (const key of monthKeys) {
    for (const row of dayModelRows(doc, key)) {
      const mapKey = `${row.provider}\u0000${row.model}`
      const existing = models.get(mapKey) ?? { provider: row.provider, model: row.model, tokens: 0, calls: 0, cost: 0 }
      existing.tokens += row.tokens
      existing.calls += row.calls
      existing.cost += row.cost
      models.set(mapKey, existing)
    }
  }
  const models30 = [...models.values()].sort((a, b) => b.tokens - a.tokens)

  const allKeys = ledgerDayKeys(doc)
  const allTimeTotals = summarizeWindow(doc, allKeys)

  return {
    generatedAt: nowMs,
    today: summarizeWindow(doc, [todayKey]),
    week: summarizeWindow(doc, weekKeys),
    month: summarizeWindow(doc, monthKeys),
    allTime: { ...allTimeTotals, firstDay: allKeys[0] },
    heatmapDays: trailing.map(key => dayPoint(doc, key)),
    bars30: trailing.slice(HEATMAP_DAYS - BARS_DAYS).map(key => dayPoint(doc, key)),
    models30,
    sessionsRecent: monthRows.slice(0, RECENT_SESSION_CAP),
  }
}

