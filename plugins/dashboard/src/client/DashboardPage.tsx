/**
 * The dashboard pages. Three panel families:
 *
 * - `DashboardPage` (panel id `dashboard`) — the ongoing agents feed as the
 *   main event: every running session (uncapped), padded with the most
 *   recent idle sessions to at most five rows, grouped by workspace with
 *   child workspaces (git worktrees, `.dsh-work` temp workspaces) nested
 *   under their repo, each row carrying a live status line (the newest
 *   assistant words, or the tool call in flight) streamed from a passive
 *   per-session event tail — zero polling. A session blocked on an
 *   `ask_user_question` call shows an inline answer box that replies
 *   through the question RPC without opening the session. Clicking a
 *   workspace header opens the workspace's own panel. Below the feed,
 *   the trailing-year heatmap, fed by a slow 60-second overview read.
 * - `WorkspacePage` (panel id `workspace-<slug>`, in WorkspacePage.tsx) —
 *   the per-workspace sub-dashboard: its sessions, child workspaces, and
 *   the same inline answers, with a back control to the landing.
 * - `UsagePage` (panel id `usage-stats`) — the statistics: headline cards,
 *   the heatmap, and the per-model/per-session tables. The 20-second
 *   ledger poll lives inside this component, so it only runs while the
 *   panel is mounted.
 * @module dashboard/client/DashboardPage
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { compactTokens, fullTimeLabel, relativeTime } from './format.ts'
import type { DashboardOverviewView, UsageDayPoint } from '../core/view.ts'
import {
  FEED_ROW_CAP, buildWorkspaceGroups, projectRows, useOptionalStore, workspaceKey,
  type AgentRow, type SessionsFace, type SessionsListState, type WorkspacesFace,
  type WorkspaceGroupNode, type WorkspaceTarget,
} from './workspace.ts'

export type { AgentRow, SessionsFace }

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
  /** Absent when the workspaces plugin is not loaded: grouping falls back to cwd. */
  workspaces: WorkspacesFace | undefined
  openDashboard(): void
  openUsage(): void
  /** Open (registering on first use) the workspace's own panel. */
  openWorkspace(target: WorkspaceTarget): void
  /** uiWorkspace.openSession: a SessionId string is a valid SessionTarget. */
  openSession(sessionId: string): void
  fetchOverview(): Promise<DashboardOverviewView | undefined>
  version: string | undefined
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
export interface PendingQuestionInfo {
  callId: string | undefined
  questions: readonly { id: string; question: string }[]
}

/** First open question of a session, from its summary projection values. */
export function pendingQuestionOf(values: Record<string, unknown> | undefined): PendingQuestionInfo | undefined {
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
export function useNowTicker(intervalMs: number): number {
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

/** One agent row: status dot, label, badges, live tail, inline answer. */
export function FeedItem({ row, now, face, question }: {
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

/**
 * One collapsible workspace group: header (caret, label, running count),
 * its rows, then nested child workspaces indented under a thin rule. The
 * label opens the workspace's own panel; the caret toggles collapse
 * (session-local state, never persisted). Reused by the workspace panel
 * for child workspaces.
 */
export function WorkspaceGroup({ node, depth, now, face, state, collapsed, collapsedSet, onToggle }: {
  node: WorkspaceGroupNode
  depth: number
  now: number
  face: DashboardFace
  state: SessionsListState
  /** Whether this node renders collapsed. */
  collapsed: boolean
  /** The shared collapse-key set children read. */
  collapsedSet: ReadonlySet<string>
  onToggle(key: string): void
}) {
  const running = node.rows.filter(row => row.running).length
  return (
    <div className="wd-group">
      <div className="wd-group-head">
        <button
          type="button"
          className="wd-group-caret"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => { onToggle(workspaceKey(node)) }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        {node.path === undefined
          ? <span className="wd-group-name">{node.label}</span>
          : (
            <button
              type="button"
              className="wd-group-name"
              title={`${node.path} — open its page`}
              onClick={() => { face.openWorkspace({ slug: node.slug, path: node.path!, label: node.label }) }}
            >
              {node.label}
            </button>
          )}
        <span className="wd-group-count" data-running={running > 0 || undefined}>
          {running > 0 ? `${running} running` : 'idle'}
        </span>
      </div>
      {!collapsed && (
        <>
          <div className="wd-feed">
            {node.rows.map(row => (
              <FeedItem
                key={row.sessionId}
                row={row}
                now={now}
                face={face}
                question={pendingQuestionOf(state.projectionsBySession[row.sessionId]?.values)}
              />
            ))}
          </div>
          {node.hidden > 0 && node.path !== undefined && (
            <button
              type="button"
              className="wd-group-more"
              onClick={() => { face.openWorkspace({ slug: node.slug, path: node.path!, label: node.label }) }}
            >
              +{node.hidden} sleeping — open {node.label}
            </button>
          )}
          {node.children.length > 0 && (
            <div className="wd-group-kids">
              {node.children.map(child => (
                <WorkspaceGroup
                  key={workspaceKey(child)}
                  node={child}
                  depth={depth + 1}
                  now={now}
                  face={face}
                  state={state}
                  collapsed={collapsedSet.has(workspaceKey(child))}
                  collapsedSet={collapsedSet}
                  onToggle={onToggle}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The landing panel: the grouped agents feed, then the year heatmap. */
export function DashboardPage(face: DashboardFace) {
  const state = useSyncExternalStore(face.sessions.list.subscribe, face.sessions.list.getSnapshot)
  const workspaces = useOptionalStore(face.workspaces?.list)
  const now = useNowTicker(30_000)
  const [view, setView] = useState<DashboardOverviewView | undefined>(undefined)
  const refreshAttempted = useRef(new Set<string>())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  // The feed always shows every running agent; the most recent idle ones
  // pad the rest of the FEED_ROW_CAP budget. Grouping keeps the whole set
  // so per-workspace counts and the "+sleeping" notes stay honest.
  const groups = useMemo(
    () => buildWorkspaceGroups(
      projectRows(state, workspaces.items),
      workspaces.items,
      { cap: FEED_ROW_CAP },
    ),
    [state, workspaces],
  )
  const rows = useMemo(() => groups.roots.flatMap(node => collapseRows(node)), [groups])

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

  const toggle = (key: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
          <span className="wd-section-note">all active, recent idles pad to {FEED_ROW_CAP} · a workspace name opens its page</span>
        </div>
        {state.phase === 'pending'
          ? <div className="wd-empty">Loading sessions…</div>
          : rows.length === 0
            ? <div className="wd-zzz" role="status">💤 all agents sleeping</div>
            : (
              <div className="wd-groups">
                {groups.roots.map(node => (
                  <WorkspaceGroup
                    key={workspaceKey(node)}
                    node={node}
                    depth={0}
                    now={now}
                    face={face}
                    state={state}
                    collapsed={collapsed.has(workspaceKey(node))}
                    collapsedSet={collapsed}
                    onToggle={toggle}
                  />
                ))}
              </div>
            )}
      </section>
      {view !== undefined && <HeatmapSection view={view} />}
    </div>
  )
}

/** The rows a node actually shows: its own plus every shown descendant's. */
function collapseRows(node: WorkspaceGroupNode): readonly AgentRow[] {
  return [...node.rows, ...node.children.flatMap(collapseRows)]
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
          <div className="wd-tablewrap">
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
          </div>
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
          <div className="wd-tablewrap">
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
          </div>
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
