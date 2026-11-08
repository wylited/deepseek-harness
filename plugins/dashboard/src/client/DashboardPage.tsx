/**
 * The dashboard pages. Two main panels:
 *
 * - `DashboardPage` (panel id `dashboard`) — the ongoing agents feed as the
 *   main event: at most three running sessions, each with a live status
 *   line (the newest assistant words, or the tool call in flight) streamed
 *   from a passive per-session event tail — zero polling. A session blocked
 *   on an `ask_user_question` call shows an inline answer box that replies
 *   through the question RPC without opening the session. Below the feed,
 *   the trailing-year heatmap, fed by a slow 60-second overview read.
 * - `UsagePage` (panel id `usage-stats`) — the statistics: headline cards,
 *   the heatmap, and the per-model/per-session tables. The 20-second
 *   ledger poll lives inside this component, so it only runs while the
 *   panel is mounted.
 * @module dashboard/client/DashboardPage
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { compactTokens, fullTimeLabel, pathBase, relativeTime } from './format.ts'
import type { DashboardOverviewView, UsageDayPoint } from '../core/view.ts'

/** The minimal runtime face of the client `sessions` service this page reads. */
export interface SessionsFace {
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): SessionsListState
  }
  refreshProjections(sessionId: string): Promise<void>
}

/** The minimal runtime face of the generated `remote.session` facade. */
export interface SessionRemoteFace {
  /** Live event tail for one Session address; passive (no activation). */
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    activate?: boolean
    assistantStream?: true
    maxMessages?: number
  }, signal?: AbortSignal): AsyncIterable<unknown>
  /** Admit one prompt to a Session without opening it. */
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: readonly { type: 'text'; text: string }[]
    clientTimeZone?: string
  }, signal?: AbortSignal): Promise<unknown>
}

/** The minimal runtime face of the generated `remote.userQuestions` facade. */
export interface QuestionRemoteFace {
  /** Answer one pending `ask_user_question` call. */
  answer(sessionId: string, callId: string, answer: {
    answers: readonly { id: string; selected: readonly string[]; custom?: string }[]
  }): Promise<unknown>
}

/** Everything the page components need, captured at apply time. */
export interface DashboardFace {
  sessions: SessionsFace
  /** Absent when the remote facade is not loaded: the feed degrades. */
  sessionRemote: SessionRemoteFace | undefined
  /** Absent when the user-questions plugin is not loaded: replies prompt instead. */
  questionRemote: QuestionRemoteFace | undefined
  openDashboard(): void
  openUsage(): void
  /** uiWorkspace.openSession: a SessionId string is a valid SessionTarget. */
  openSession(sessionId: string): void
  fetchOverview(): Promise<DashboardOverviewView | undefined>
  version: string | undefined
}

/** The list snapshot fields the feed reads. */
interface SessionSummaryRow {
  /** The session identity (the `sessions.list` store keys `byId` by it). */
  id: string
  displayTitle?: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
}

interface SessionsListState {
  ids: readonly string[]
  byId: Record<string, SessionSummaryRow>
  phase: 'pending' | 'ready'
  projectionsBySession: Record<string, { values: Record<string, unknown> } | undefined>
}

/** One feed row after projection, labels already display-ready. */
interface AgentRow {
  sessionId: string
  label: string
  updatedAt: number
  running: boolean
  subagent: boolean
  parentLabel: string | undefined
  model: string | undefined
}

/** How many running agents the feed shows at most. */
const ACTIVE_CAP = 3

/** Workspace basenames that read as noise on a personal page: this repo's
 *  checkout dir. The parent directory names the checkout more usefully. */
const NOISY_BASENAME = 'dsh'

/** Read the model a session's durable selection names (next, then last used). */
function modelOfProjection(values: Record<string, unknown> | undefined): string | undefined {
  if (values === undefined) return undefined
  const selection = values['modelSelection']
  if (typeof selection !== 'object' || selection === null) return undefined
  const read = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'object' || candidate === null || !('model' in candidate)) return undefined
    return typeof candidate.model === 'string' && candidate.model !== '' ? candidate.model : undefined
  }
  const next = 'next' in selection ? read(selection.next) : undefined
  const lastUsed = 'lastUsed' in selection ? read(selection.lastUsed) : undefined
  return next ?? lastUsed
}

/** A workspace path's usable name: its basename, unless that is the bare
 *  repo dir (`dsh`), in which case the parent directory speaks instead. */
function neutralBase(cwd: string | undefined): string | undefined {
  const base = pathBase(cwd)
  if (base === undefined || base.toLowerCase() !== NOISY_BASENAME) return base
  const trimmed = cwd!.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut > 0 ? pathBase(trimmed.slice(0, cut)) : undefined
}

/** The label a row shows: the session title, else a workspace name that is
 *  not the bare repo dir, else a truncated session id. */
function displayLabel(title: string | undefined, cwd: string | undefined, id: string): string {
  if (title !== undefined && title !== '' && title !== id && title.toLowerCase() !== NOISY_BASENAME) return title
  return neutralBase(cwd) ?? `${id.slice(0, 10)}…`
}

/** Project the raw list snapshot into feed rows (uncapped, unsorted). */
function projectRows(state: SessionsListState): AgentRow[] {
  const rows: AgentRow[] = []
  for (const id of state.ids) {
    const summary = state.byId[id]
    if (summary === undefined) continue
    if (summary.blank && !summary.running) continue
    const parent = summary.parentSessionId === undefined ? undefined : state.byId[summary.parentSessionId]
    rows.push({
      sessionId: summary.id,
      label: displayLabel(summary.displayTitle, summary.cwd, summary.id),
      updatedAt: summary.updatedAt,
      running: summary.running,
      subagent: summary.origin === 'subagent',
      parentLabel: parent === undefined
        ? undefined
        : displayLabel(parent.displayTitle, parent.cwd, parent.id),
      model: modelOfProjection(state.projectionsBySession[id]?.values),
    })
  }
  return rows
}

/** The running agents: latest first, capped. */
function activeRows(state: SessionsListState): AgentRow[] {
  return projectRows(state)
    .filter(row => row.running)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, ACTIVE_CAP)
}

// --- live status lines ------------------------------------------------------

/** One journal event envelope; payloads are owner-defined JSON. */
interface WireEvent {
  type: string
  data: unknown
}

/** Last non-blank line of a text, capped for the feed. */
function lastLine(text: string): string | undefined {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.length > 90 ? `${trimmed.slice(0, 89)}…` : trimmed
  }
  return undefined
}

/** Last assistant words of one `assistant/message` payload. */
function messageLine(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('message' in data)) return undefined
  const message: unknown = data.message
  if (typeof message !== 'object' || message === null || !('content' in message)) return undefined
  const content: unknown = message.content
  if (typeof content === 'string') return lastLine(content)
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap(part => {
    if (typeof part !== 'object' || part === null) return []
    if (!('type' in part) || !('text' in part)) return []
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('\n')
  return lastLine(text)
}

/** A string field of an owner-defined event payload. */
function dataString(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null || !(key in data)) return undefined
  const value: unknown = data[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The feed status line from an event tail: an unmatched `tool/call` names
 * the tool in flight; otherwise the newest assistant words. Undefined
 * means "nothing readable yet" — the row shows the degraded working line.
 */
function statusOf(events: readonly WireEvent[]): string | undefined {
  let toolName: string | undefined
  let toolCallId: string | undefined
  let assistant: string | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      toolName = dataString(event.data, 'name') ?? 'tool'
      toolCallId = dataString(event.data, 'callId') ?? toolCallId
      assistant = undefined
    } else if (event.type === 'tool/result' && dataString(event.data, 'callId') === toolCallId) {
      toolName = undefined
      toolCallId = undefined
    } else if (event.type === 'assistant/message') {
      const line = messageLine(event.data)
      if (line !== undefined) assistant = line
    }
  }
  return toolName === undefined ? assistant : `running: ${toolName}`
}

/**
 * Live status line for one running session: a passive per-session event
 * tail (snapshot + live frames) through the generated session facade —
 * subscribed only while the row shows, aborted on unmount. Stream failure
 * returns undefined, the degraded `working…` rendering.
 */
function useSessionTail(face: DashboardFace, sessionId: string): string | undefined {
  const [line, setLine] = useState<string | undefined>(undefined)
  useEffect(() => {
    const remote = face.sessionRemote
    if (remote === undefined) return
    const controller = new AbortController()
    let alive = true
    const events: WireEvent[] = []
    const push = (rawEvent: unknown): void => {
      if (typeof rawEvent !== 'object' || rawEvent === null) return
      if (!('type' in rawEvent) || !('data' in rawEvent)) return
      if (typeof rawEvent.type !== 'string') return
      // Envelope shape-checked above; payloads stay owner-defined JSON.
      events.push({ type: rawEvent.type, data: rawEvent.data })
      if (events.length > 120) events.splice(0, events.length - 120)
    }
    const run = async (): Promise<void> => {
      try {
        const tail = remote.follow(
          { address: { kind: 'session', sessionId }, maxMessages: 40 },
          controller.signal,
        )
        for await (const raw of tail) {
          if (!alive || controller.signal.aborted) return
          if (typeof raw !== 'object' || raw === null || !('type' in raw)) continue
          if (raw.type === 'snapshot' && 'records' in raw && Array.isArray(raw.records)) {
            events.length = 0
            for (const record of raw.records) {
              if (typeof record === 'object' && record !== null && 'event' in record) push(record.event)
            }
          } else if (raw.type === 'event' && 'event' in raw) {
            push(raw.event)
          } else {
            continue
          }
          setLine(statusOf(events))
        }
      } catch {
        // Stream failed or was aborted: the row renders the degraded line.
      }
    }
    void run()
    return () => {
      alive = false
      controller.abort()
    }
  }, [face, sessionId])
  return line
}

// --- inline answers ---------------------------------------------------------

/** One pending `ask_user_question` call read from the session list summary. */
interface PendingQuestionInfo {
  callId: string | undefined
  questions: readonly { id: string; question: string }[]
}

/** First open question of a session, from its summary projection values. */
function pendingQuestionOf(values: Record<string, unknown> | undefined): PendingQuestionInfo | undefined {
  if (values === undefined) return undefined
  const view: unknown = values['userQuestions']
  if (typeof view !== 'object' || view === null || !('active' in view)) return undefined
  const active: unknown = view.active
  if (!Array.isArray(active)) return undefined
  for (const item of active) {
    if (typeof item !== 'object' || item === null || !('questions' in item)) continue
    if (!Array.isArray(item.questions)) continue
    const callId = 'callId' in item && typeof item.callId === 'string' ? item.callId : undefined
    const questions = item.questions.flatMap(question => {
      if (typeof question !== 'object' || question === null) return []
      if (!('id' in question) || !('question' in question)) return []
      if (typeof question.id !== 'string' || typeof question.question !== 'string') return []
      return [{ id: question.id, question: question.question }]
    })
    return { callId, questions }
  }
  return undefined
}

/** Deliver one inline reply: the pending question's own RPC when named,
 *  otherwise a queued prompt to the session. */
async function submitAnswer(
  face: DashboardFace,
  sessionId: string,
  question: PendingQuestionInfo,
  text: string,
): Promise<void> {
  if (face.questionRemote !== undefined && question.callId !== undefined) {
    await face.questionRemote.answer(sessionId, question.callId, {
      answers: question.questions.map(item => ({ id: item.id, selected: [], custom: text })),
    })
    return
  }
  await face.sessionRemote?.prompt({
    requestId: crypto.randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

/** The inline answer box under one agent row. */
function InlineAnswer({ face, sessionId, question }: {
  face: DashboardFace
  sessionId: string
  question: PendingQuestionInfo
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const hint = question.questions.map(item => item.question).join(' · ')
  const submit = (): void => {
    const text = value.trim()
    if (text === '' || busy) return
    setBusy(true)
    void submitAnswer(face, sessionId, question, text)
      .then(() => { setValue('') })
      .catch(() => {})
      .finally(() => { setBusy(false) })
  }
  return (
    <form className="wd-answer" onSubmit={event => { event.preventDefault(); submit() }}>
      {hint !== '' && <span className="wd-answer-q" title={hint}>{hint}</span>}
      <input
        className="wd-answer-input"
        type="text"
        value={value}
        placeholder="reply without opening the session…"
        onChange={event => { setValue(event.target.value) }}
      />
      <button type="submit" className="wd-answer-send" disabled={busy || value.trim() === ''}>
        {busy ? '…' : 'send'}
      </button>
    </form>
  )
}

/** A shared `Date.now()` ticker so relative labels move without re-render storms. */
function useNowTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, intervalMs)
    return () => { window.clearInterval(timer) }
  }, [intervalMs])
  return now
}

/** The version chip: click copies, briefly confirms. */
function VersionChip({ version }: { version: string | undefined }) {
  const [copiedAt, setCopiedAt] = useState(0)
  if (version === undefined) return null
  const copy = (): void => {
    void navigator.clipboard?.writeText(version).then(() => { setCopiedAt(Date.now()) }).catch(() => {})
  }
  return (
    <button
      type="button"
      className="wd-version"
      data-copied={Date.now() - copiedAt < 1_500 || undefined}
      onClick={copy}
      title="Copy version"
    >
      {version}
    </button>
  )
}

function FeedItem({ row, now, face, question }: {
  row: AgentRow
  now: number
  face: DashboardFace
  question: PendingQuestionInfo | undefined
}) {
  const status = useSessionTail(face, row.sessionId)
  return (
    <div className="wd-feeditem">
      <button
        type="button"
        className="wd-row"
        onClick={() => { face.openSession(row.sessionId) }}
        title={`${row.label} — ${fullTimeLabel(row.updatedAt)}`}
      >
        <span className="wd-dot" data-running={row.running || undefined} aria-hidden="true" />
        <span className="wd-row-main">
          <span className="wd-row-title">{row.label}</span>
          {row.subagent && row.parentLabel !== undefined && (
            <span className="wd-row-sub">↳ {row.parentLabel}</span>
          )}
        </span>
        {row.subagent && <span className="wd-badge" data-accent>subagent</span>}
        {row.model !== undefined && <span className="wd-badge">{row.model}</span>}
        <span className="wd-when">{relativeTime(row.updatedAt, now)}</span>
      </button>
      <div className="wd-row-status" data-degraded={status === undefined || undefined}>
        {status ?? 'working…'}
      </div>
      {question !== undefined && <InlineAnswer face={face} sessionId={row.sessionId} question={question} />}
    </div>
  )
}

/** The landing panel: the agents feed, then the year heatmap. */
export function DashboardPage(face: DashboardFace) {
  const state = useSyncExternalStore(face.sessions.list.subscribe, face.sessions.list.getSnapshot)
  const now = useNowTicker(30_000)
  const [view, setView] = useState<DashboardOverviewView | undefined>(undefined)
  const refreshAttempted = useRef(new Set<string>())

  const rows = useMemo(() => activeRows(state), [state])

  // Cold model names arrive through the projections read (same RPC the
  // workspace list uses for cold titles); one attempt per session per mount.
  useEffect(() => {
    for (const row of rows) {
      if (row.model !== undefined || refreshAttempted.current.has(row.sessionId)) continue
      refreshAttempted.current.add(row.sessionId)
      void face.sessions.refreshProjections(row.sessionId).catch(() => {})
    }
  })

  // The dashboard's only ledger use is the heatmap; a 60-second read is plenty.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      face.fetchOverview().then(next => {
        if (!cancelled && next !== undefined) setView(next)
      }).catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [face])

  return (
    <div className="wd-page">
      <header className="wd-header">
        <h1 className="wd-title">Dashboard</h1>
        <VersionChip version={face.version} />
        <span className="wd-header-spring" />
        <button type="button" className="wd-navbtn" onClick={face.openUsage}>Usage statistics</button>
      </header>
      <section className="wd-section">
        <div className="wd-section-head">
          <h2 className="wd-section-title">Ongoing agents</h2>
          <span className="wd-section-note">running now · click a row to open</span>
        </div>
        {state.phase === 'pending'
          ? <div className="wd-empty">Loading sessions…</div>
          : rows.length === 0
            ? <div className="wd-zzz" role="status">💤 all agents sleeping</div>
            : (
              <div className="wd-feed">
                {rows.map(row => (
                  <FeedItem
                    key={row.sessionId}
                    row={row}
                    now={now}
                    face={face}
                    question={pendingQuestionOf(state.projectionsBySession[row.sessionId]?.values)}
                  />
                ))}
              </div>
            )}
      </section>
      {view !== undefined && <HeatmapSection view={view} />}
    </div>
  )
}

/** One headline card. */
function HeadlineCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="wd-card">
      <div className="wd-card-num">{value}</div>
      <div className="wd-card-label">{label}</div>
      {sub !== undefined && <div className="wd-card-sub">{sub}</div>}
    </div>
  )
}

/** Aggregate window label with a session count. */
function windowSub(window: { sessions: number; calls: number }): string {
  return `${window.sessions} session${window.sessions === 1 ? '' : 's'} · ${window.calls} call${window.calls === 1 ? '' : 's'}`
}

/** The headline token/cost cards. */
function StatCards({ view }: { view: DashboardOverviewView }) {
  return (
    <div className="wd-cards">
      <HeadlineCard label="Tokens today" value={compactTokens(view.today.tokens)} sub={windowSub(view.today)} />
      <HeadlineCard label="Tokens · 7 days" value={compactTokens(view.week.tokens)} sub={windowSub(view.week)} />
      <HeadlineCard label="Tokens · 30 days" value={compactTokens(view.month.tokens)} sub={windowSub(view.month)} />
      <HeadlineCard
        label="Cost estimate"
        value={view.month.cost > 0 ? `¥${compactTokens(Math.round(view.month.cost))}` : '—'}
        sub={view.month.cost > 0 ? 'priced routes, 30 days' : 'no priced routes in use'}
      />
    </div>
  )
}

/** Per-model leaderboard (30 days). */
function ModelTable({ view }: { view: DashboardOverviewView }) {
  const models = view.models30.slice(0, 6)
  const maxModelTokens = models[0]?.tokens ?? 0
  return (
    <section className="wd-section">
      <div className="wd-section-head">
        <h3 className="wd-section-title">By model · 30 days</h3>
        <span className="wd-section-note">{compactTokens(view.month.tokens)} tokens total</span>
      </div>
      {models.length === 0
        ? <div className="wd-empty">No model activity in the trailing 30 days.</div>
        : (
          <table className="wd-table">
            <thead>
              <tr>
                <th>Route / model</th>
                <th data-num>Tokens</th>
                <th data-num>Calls</th>
                <th data-num>Share</th>
              </tr>
            </thead>
            <tbody>
              {models.map(row => (
                <tr key={`${row.provider}/${row.model}`}>
                  <td>
                    <span className="wd-model">{row.model}</span>
                    {' '}
                    <span className="wd-dim">via {row.provider}</span>
                  </td>
                  <td data-num>{compactTokens(row.tokens)}</td>
                  <td data-num>{row.calls}</td>
                  <td data-num>
                    <span className="wd-share" style={{ width: `${Math.max(4, Math.round((row.tokens / maxModelTokens) * 90))}px` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  )
}

/** Recent per-session usage (trailing 30 days, most recent first). */
function RecentSessions({ view }: { view: DashboardOverviewView }) {
  return (
    <section className="wd-section">
      <div className="wd-section-head">
        <h3 className="wd-section-title">Recent sessions · 30 days</h3>
        <span className="wd-section-note">{view.allTime.tokens === 0 ? '' : `ledger since ${view.allTime.firstDay}`}</span>
      </div>
      {view.sessionsRecent.length === 0
        ? <div className="wd-empty">No recorded usage yet — the ledger folds each assistant reply's token report.</div>
        : (
          <table className="wd-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Model</th>
                <th data-num>Tokens</th>
                <th data-num>Calls</th>
                <th data-num>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {view.sessionsRecent.map(row => (
                <tr key={row.sessionId}>
                  <td title={row.sessionId}><span className="wd-dim">{row.sessionId.slice(0, 10)}…</span></td>
                  <td><span className="wd-model">{row.model}</span> <span className="wd-dim">via {row.provider}</span></td>
                  <td data-num>{compactTokens(row.tokens)}</td>
                  <td data-num>{row.calls}</td>
                  <td data-num>{relativeTime(row.lastAt, view.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </section>
  )
}

/** Heatmap intensity: 0..4 from a day's token total against the period max. */
function heatLevel(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0
  if (tokens < max * 0.08) return 1
  if (tokens < max * 0.25) return 2
  if (tokens < max * 0.55) return 3
  return 4
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Weekday labels the heatmap's left column shows (Monday-first grid). */
const HEAT_DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''] as const

/** One heatmap column: a label row plus seven cells (Mon..Sun). */
interface HeatColumn {
  label: string | undefined
  cells: ({ date: string; tokens: number; sessions: number; level: number } | undefined)[]
}

/** Lay the ascending day series out into Monday-first week columns. */
function heatColumns(days: readonly UsageDayPoint[], max: number): HeatColumn[] {
  const head = days[0]
  if (head === undefined) return []
  const first = new Date(head.date + 'T12:00:00')
  // Monday-first offset of the series head, so today lands on its weekday.
  const lead = (first.getDay() + 6) % 7
  const cells: (HeatColumn['cells'][number])[] = []
  for (let index = 0; index < lead; index += 1) cells.push(undefined)
  for (const day of days) {
    cells.push({
      date: day.date,
      tokens: day.tokens,
      sessions: day.sessions,
      level: heatLevel(day.tokens, max),
    })
  }
  const columns: HeatColumn[] = []
  let previousMonth = -1
  for (let index = 0; index < cells.length; index += 7) {
    const slice = cells.slice(index, index + 7)
    while (slice.length < 7) slice.push(undefined)
    const firstReal = slice.find(cell => cell !== undefined)
    let label: string | undefined
    if (firstReal !== undefined) {
      const month = new Date(firstReal.date + 'T12:00:00').getMonth()
      const monthName = MONTH_LABELS[month]
      if (monthName !== undefined && month !== previousMonth) {
        label = monthName
        previousMonth = month
      }
    }
    columns.push({ label, cells: slice })
  }
  return columns
}

/** Day tooltip for a heatmap cell. */
function heatCellTitle(cell: NonNullable<HeatColumn['cells'][number]>): string {
  return `${cell.date}: ${compactTokens(cell.tokens)} tokens · ${cell.sessions} session${cell.sessions === 1 ? '' : 's'}`
}

/** The trailing-year activity heatmap + trailing-30-day bars. */
function HeatmapSection({ view }: { view: DashboardOverviewView }) {
  const max = Math.max(1, ...view.heatmapDays.map(day => day.tokens))
  const columns = useMemo(() => heatColumns(view.heatmapDays, max), [view, max])
  const barMax = Math.max(1, ...view.bars30.map(day => day.tokens))
  const anyActivity = view.heatmapDays.some(day => day.tokens > 0)
  const today = view.bars30.at(-1)
  const todayKey = view.heatmapDays.at(-1)?.date
  return (
    <section className="wd-section">
      <div className="wd-section-head">
        <h3 className="wd-section-title">Daily activity · trailing year</h3>
        {anyActivity
          ? <span className="wd-section-note">peak day {compactTokens(max)} tokens</span>
          : <span className="wd-section-note">no usage recorded yet</span>}
      </div>
      <div className="wd-heat-scroll">
        <div className="wd-heat-grid">
          <div className="wd-heat-days" aria-hidden="true">
            <span className="wd-heat-day" />
            {HEAT_DAY_LABELS.map((label, index) => (
              <span className="wd-heat-day" key={index}>{label}</span>
            ))}
          </div>
          <div className="wd-heat">
            {columns.map((column, index) => (
              <div className="wd-heat-col" key={index}>
                <span className="wd-heat-label">{column.label ?? ''}</span>
                {column.cells.map((cell, cellIndex) => cell === undefined
                  ? <span className="wd-heat-cell" key={cellIndex} style={{ background: 'transparent' }} />
                  : (
                    <span
                      key={cellIndex}
                      className="wd-heat-cell"
                      data-level={cell.level}
                      data-today={cell.date === todayKey || undefined}
                      title={heatCellTitle(cell)}
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="wd-bars" aria-hidden="true">
        {view.bars30.map(day => (
          <span
            key={day.date}
            className="wd-bar"
            data-today={day === today || undefined}
            style={{ height: `${Math.max(4, Math.round((day.tokens / barMax) * 100))}%` }}
            title={`${day.date}: ${compactTokens(day.tokens)} tokens`}
          />
        ))}
      </div>
      <div className="wd-bars-caption">
        <span>{view.bars30[0]?.date ?? ''}</span>
        <span>trailing 30 days, tokens</span>
        <span>{today?.date ?? ''}</span>
      </div>
      <div className="wd-heat-foot">
        <span>less</span>
        <span className="wd-heat-cell" />
        <span className="wd-heat-cell" data-level="1" />
        <span className="wd-heat-cell" data-level="2" />
        <span className="wd-heat-cell" data-level="3" />
        <span className="wd-heat-cell" data-level="4" />
        <span>more</span>
      </div>
    </section>
  )
}

/** The usage page: cards, tables, and the year heatmap, on their own panel. */
export function UsagePage(face: DashboardFace) {
  const [view, setView] = useState<DashboardOverviewView | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  // The 20s ledger poll lives here, so it runs only while this panel mounts.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      face.fetchOverview().then(next => {
        if (cancelled) return
        if (next === undefined) {
          setFailed(true)
          return
        }
        setFailed(false)
        setView(next)
      }).catch(() => {
        if (!cancelled) setFailed(true)
      })
    }
    load()
    const timer = window.setInterval(load, 20_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [face])

  return (
    <div className="wd-page">
      <header className="wd-header">
        <h1 className="wd-title">Usage statistics</h1>
        <span className="wd-header-spring" />
        <button type="button" className="wd-navbtn" onClick={face.openDashboard}>← Dashboard</button>
      </header>
      {failed && <div className="wd-error">Usage ledger unreachable (host route /api/dashboard/overview).</div>}
      {view !== undefined && (
        <>
          <StatCards view={view} />
          <HeatmapSection view={view} />
          <ModelTable view={view} />
          <RecentSessions view={view} />
          <div className="wd-updated">folded from live sessions · refreshes every 20s · last {fullTimeLabel(view.generatedAt)}</div>
        </>
      )}
    </div>
  )
}
