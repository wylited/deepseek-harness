/**
 * Workspace grouping for the dashboard pages.
 *
 * The client `sessions` list (plus, when loaded, the client `workspaces`
 * list) is projected into display-ready agent rows, each row is assigned to
 * a workspace (workspace membership first, the session `cwd` as fallback),
 * and the flat assignment folds into a group tree: a workspace whose path
 * sits under another workspace's path behind a dot-directory —
 * `.dsh-work/<name>` temp workspaces, `.worktrees/<name>` git worktrees —
 * nests as its child. Group slugs name the `workspace-<slug>` panels the
 * host panel registry holds.
 * @module dashboard/client/workspace
 */

import { useMemo, useSyncExternalStore } from 'react'
import { pathBase } from './format.ts'

// --- store faces ------------------------------------------------------------

/** The minimal runtime face of the client `sessions` service these pages read. */
export interface SessionsFace {
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): SessionsListState
  }
  refreshProjections(sessionId: string): Promise<void>
}

/** The list snapshot fields the feed reads. */
export interface SessionSummaryRow {
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

export interface SessionsListState {
  ids: readonly string[]
  byId: Record<string, SessionSummaryRow>
  phase: 'pending' | 'ready'
  projectionsBySession: Record<string, { values: Record<string, unknown> } | undefined>
}

/** The minimal runtime face of the client `workspaces` service (optional). */
export interface WorkspacesFace {
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): WorkspacesListState
  }
}

/** The workspace snapshot fields the grouping reads. */
export interface WorkspacesListState {
  items: readonly WorkspaceItemView[]
  archivedSessionIds: readonly string[]
}

/** One host workspace row (canonical path, title, accounted sessions). */
export interface WorkspaceItemView {
  workspaceId: string
  path: string
  title: string
  sessionIds: readonly string[]
}

/** The workspace panel a click asks for: registry key suffix, path, label. */
export interface WorkspaceTarget {
  /** Unique `workspace-<slug>` panel id suffix. */
  slug: string
  /** The workspace's canonical path. */
  path: string
  /** The label the header showed. */
  label: string
}

// --- rows -------------------------------------------------------------------

/** One feed row after projection, labels already display-ready. */
export interface AgentRow {
  sessionId: string
  label: string
  updatedAt: number
  running: boolean
  subagent: boolean
  parentLabel: string | undefined
  model: string | undefined
  /** Workspace path the row is accounted to; undefined when nothing names one. */
  workspacePath: string | undefined
  /** The workspace's display label (workspace title, else path basename). */
  workspaceLabel: string | undefined
}

/** How many rows the landing feed shows at most: every running agent
 *  always shows, recent idle agents pad the rest of the budget. */
export const FEED_ROW_CAP = 5

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
export function neutralBase(cwd: string | undefined): string | undefined {
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

/** The workspace a session is accounted to: host workspace membership when
 *  the workspaces list is loaded, else the session's own `cwd`. */
function workspaceOf(
  summary: SessionSummaryRow,
  items: readonly WorkspaceItemView[] | undefined,
): { path: string | undefined; label: string | undefined } {
  const item = items?.find(candidate => candidate.sessionIds.includes(summary.id))
  if (item !== undefined) {
    return { path: item.path, label: item.title !== '' ? item.title : neutralBase(item.path) }
  }
  if (summary.cwd !== undefined && summary.cwd !== '') {
    return { path: summary.cwd, label: neutralBase(summary.cwd) }
  }
  return { path: undefined, label: undefined }
}

/** Project the raw list snapshot into feed rows (uncapped, unsorted). */
export function projectRows(
  state: SessionsListState,
  workspaces: readonly WorkspaceItemView[] | undefined = undefined,
): AgentRow[] {
  const rows: AgentRow[] = []
  for (const id of state.ids) {
    const summary = state.byId[id]
    if (summary === undefined) continue
    if (summary.blank && !summary.running) continue
    const parent = summary.parentSessionId === undefined ? undefined : state.byId[summary.parentSessionId]
    const workspace = workspaceOf(summary, workspaces)
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
      workspacePath: workspace.path,
      workspaceLabel: workspace.label,
    })
  }
  return rows
}

// --- group tree -------------------------------------------------------------

/** One collapsible workspace group: its sessions, then child workspaces. */
export interface WorkspaceGroupNode {
  /** Workspace path; undefined for the no-workspace bucket (never a panel). */
  path: string | undefined
  label: string
  /** `workspace-<slug>` panel id suffix; unique across the current tree. */
  slug: string
  /** Sessions assigned directly to this workspace, newest first. */
  rows: readonly AgentRow[]
  /** Rows the feed cap hid here (they live on the workspace's own panel). */
  hidden: number
  children: readonly WorkspaceGroupNode[]
  /** Newest activity anywhere in this subtree (ordering key). */
  activity: number
}

/** The grouped feed: root groups plus the uncapped per-path running counts. */
export interface WorkspaceGroups {
  roots: readonly WorkspaceGroupNode[]
  /** True running count per workspace path, from the rows the builder saw. */
  runningByPath: ReadonlyMap<string | undefined, number>
}

export interface BuildGroupsOptions {
  /** Show at most this many rows overall: every running row always shows,
   *  the newest non-running rows pad the rest of the budget; undefined = all. */
  cap?: number
  /** Also include workspaces nested under this path as (possibly empty)
   *  structural nodes, so a panel can list its idle child workspaces. */
  childOf?: string
}

/** Collapse trailing slashes so prefix checks compare canonical spellings. */
function normalized(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** True when `child` sits under `parent` behind one dot-directory segment
 *  (`.dsh-work/<name>`, `.worktrees/<name>`); plain subdirectories do not
 *  nest — they are their own top-level workspaces. */
function isNestedPath(child: string, parent: string): boolean {
  const prefix = parent + '/'
  if (!child.startsWith(prefix)) return false
  return child.slice(prefix.length).split('/')[0]!.startsWith('.')
}

/** The `workspace-<slug>` suffix: lowercase display label, non-alnum → `-`. */
export function workspaceSlug(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'workspace' : slug
}

/** Stable React/collapse key for a group node. */
export function workspaceKey(node: WorkspaceGroupNode): string {
  return node.path ?? `\u0000${node.slug}`
}

/** Depth-first lookup of a group node by workspace path. */
export function findGroupNode(nodes: readonly WorkspaceGroupNode[], path: string): WorkspaceGroupNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    const nested = findGroupNode(node.children, path)
    if (nested !== undefined) return nested
  }
  return undefined
}

/**
 * Fold rows into the workspace group tree. Every row's workspace becomes a
 * node; host workspaces that are dot-ancestors of row paths (or, with
 * `childOf`, that nest under it) join as structural nodes so nesting stays
 * visible even when a parent has no rows of its own. Labels come from the
 * workspace title, else the path basename; slugs are made unique per tree.
 */
export function buildWorkspaceGroups(
  rows: readonly AgentRow[],
  items: readonly WorkspaceItemView[] | undefined = undefined,
  options: BuildGroupsOptions = {},
): WorkspaceGroups {
  const runningByPath = new Map<string | undefined, number>()
  const assigned = new Map<string | undefined, AgentRow[]>()
  const rowPaths = new Set<string>()
  for (const row of rows) {
    runningByPath.set(row.workspacePath, (runningByPath.get(row.workspacePath) ?? 0) + (row.running ? 1 : 0))
    const bucket = assigned.get(row.workspacePath) ?? []
    bucket.push(row)
    assigned.set(row.workspacePath, bucket)
    if (row.workspacePath !== undefined) rowPaths.add(normalized(row.workspacePath))
  }

  // Structural nodes: host workspaces that dot-ancestor row paths, and (for
  // a workspace panel) host workspaces nested under the panel's path.
  const structural = new Set<string>()
  for (const item of items ?? []) {
    const path = normalized(item.path)
    if (rowPaths.has(path)) continue
    const ancestorsRow = [...rowPaths].some(rowPath => isNestedPath(rowPath, path))
    const underPanel = options.childOf !== undefined && path !== normalized(options.childOf)
      && isNestedPath(path, normalized(options.childOf))
    if (ancestorsRow || underPanel) structural.add(path)
  }

  const titleByPath = new Map<string, string>()
  for (const item of items ?? []) titleByPath.set(normalized(item.path), item.title)

  const allPaths = [...rowPaths, ...structural].sort()
  const usedSlugs = new Set<string>()
  const byPath = new Map<string, WorkspaceGroupNode>()
  for (const path of allPaths) {
    const label = titleByPath.get(path) || neutralBase(path) || path
    let slug = workspaceSlug(label)
    for (let attempt = 2; usedSlugs.has(slug); attempt += 1) slug = `${workspaceSlug(label)}-${attempt}`
    usedSlugs.add(slug)
    byPath.set(path, { path, label, slug, rows: [], hidden: 0, children: [], activity: 0 })
  }
  const unassigned: WorkspaceGroupNode[] = []
  if (assigned.has(undefined)) {
    unassigned.push({
      path: undefined, label: 'No workspace', slug: 'none',
      rows: [], hidden: 0, children: [], activity: 0,
    })
  }

  // Longest dot-ancestor among the node paths parents each node.
  const parentOf = new Map<string, string | undefined>()
  for (const path of allPaths) {
    let best: string | undefined
    for (const candidate of allPaths) {
      if (candidate !== path && isNestedPath(path, candidate) && (best === undefined || candidate.length > best.length)) {
        best = candidate
      }
    }
    parentOf.set(path, best)
  }

  const nodes = [...unassigned, ...byPath.values()]
  let shownIds: Set<string> | undefined
  if (options.cap !== undefined) {
    shownIds = new Set()
    const ordered = [...rows].sort((a, b) => b.updatedAt - a.updatedAt)
    let budget = options.cap
    for (const row of ordered) {
      if (!row.running) continue
      shownIds.add(row.sessionId)
      budget -= 1
    }
    for (const row of ordered) {
      if (row.running || budget <= 0) continue
      shownIds.add(row.sessionId)
      budget -= 1
    }
  }
  for (const [path, bucket] of assigned) {
    const node = path === undefined ? unassigned[0]! : byPath.get(normalized(path))!
    const shown = shownIds === undefined ? [...bucket] : bucket.filter(row => shownIds.has(row.sessionId))
    node.rows = shown.sort((a, b) => b.updatedAt - a.updatedAt)
    node.hidden = bucket.length - node.rows.length
  }
  const activityOf = (node: WorkspaceGroupNode): number =>
    Math.max(node.rows[0]?.updatedAt ?? 0, ...node.children.map(activityOf))
  const link = (node: WorkspaceGroupNode): WorkspaceGroupNode => {
    node.children = [...byPath.values()]
      .filter(child => parentOf.get(child.path!) === node.path)
      .sort((a, b) => activityOf(b) - activityOf(a))
    node.children = node.children.map(link)
    node.activity = activityOf(node)
    return node
  }
  const roots = nodes
    .filter(node => node.path === undefined || parentOf.get(node.path) === undefined)
    .map(link)
    .sort((a, b) => b.activity - a.activity)
  return { roots, runningByPath }
}

// --- optional store hook ----------------------------------------------------

const NO_WORKSPACES: WorkspacesListState = { items: [], archivedSessionIds: [] }

/** Subscribe an optional snapshot store; absent stores read an empty state
 *  (the `workspaces` service uses `this`-bound methods, so the wrappers are
 *  built once per store). */
export function useOptionalStore(store: WorkspacesFace['list'] | undefined): WorkspacesListState {
  const subscribe = useMemo(
    () => store === undefined ? () => () => {} : (fn: () => void) => store.subscribe(fn),
    [store],
  )
  const getSnapshot = useMemo(
    () => store === undefined ? () => NO_WORKSPACES : () => store.getSnapshot(),
    [store],
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}
