/**
 * dashboard, client half. Registers the main panels — the landing page
 * (`dashboard`, the workspace-grouped agents feed with live status lines,
 * inline answers, and the year heatmap), the usage statistics page
 * (`usage-stats`), and per-workspace sub-dashboards (`workspace-<slug>`,
 * registered on first open) — plus the sidebar brand slots, the usage
 * sidebar entry, the landing selection, and the stylesheet.
 * @module dashboard/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { FishLogo } from './fish-logo.ts'
import { DASHBOARD_CSS } from './dashboard-css.ts'
import { DashboardPage, UsagePage, type DashboardFace, type QuestionRemoteFace, type SessionRemoteFace, type SessionsFace } from './DashboardPage.tsx'
import { WorkspacePage } from './WorkspacePage.tsx'
import type { DashboardOverviewView } from '../core/view.ts'
import type { WorkspacesFace, WorkspaceTarget } from './workspace.ts'

/** Required services: the slot registry, the layout panel store, live sessions. */
export const inject = ['slots', 'layout', 'sessions']

/** The id shared by the landing panel and the landing selection. */
const PANEL_ID = 'dashboard'

/** The usage statistics panel id — matches plugins/keys' palette command. */
const USAGE_PANEL_ID = 'usage-stats'

/** Runtime service lookup: string-keyed `get`, wider than the declared names. */
interface DashboardContext extends ClientContext {
  get(name: string): unknown
}

/** The boot graph's release block, installed by the host before any bundle runs. */
interface BootGraph {
  release?: { version?: string; commit?: string }
}

/** Read a service that may be absent (optional integration points). */
function tryGet<T>(ctx: DashboardContext, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** The host release identity the boot graph publishes. */
function bootRelease(): { version?: string; commit?: string } | undefined {
  return (window as { __DSH_BOOT__?: BootGraph }).__DSH_BOOT__?.release
}

// --- actions ---------------------------------------------------------------

/** Brand mark slot: the whale navigates to the dashboard. */
function BrandMark(face: DashboardFace & { size?: number }) {
  return (
    <span
      className="wd-brandmark"
      data-copy-version
      title="Open dashboard"
      onClick={(event) => {
        // The collapsed rail nests this mark inside the expand toggle.
        if (event.currentTarget.closest('[data-sidebar-toggle]') !== null) return
        face.openDashboard()
      }}
    >
      <FishLogo size={face.size ?? 24} />
    </span>
  )
}

/** Brand name slot: the sidebar label; click = dashboard. */
function BrandName(face: DashboardFace) {
  return (
    <span className="wd-brandname" data-copy-version title="Open dashboard" onClick={() => { face.openDashboard() }}>
      <span className="wd-brandname-title">dsh</span>
      {face.version !== undefined && <span className="wd-brandname-version">{face.version}</span>}
    </span>
  )
}

/** Sidebar panel-list icon for the usage page (inline bars, no icon deps). */
function UsagePanelIcon({ size }: { size?: number }) {
  const dimension = size ?? 20
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="10" width="3.4" height="7.5" fill="currentColor" />
      <rect x="8.3" y="5.5" width="3.4" height="12" fill="currentColor" />
      <rect x="14.1" y="2.5" width="3.4" height="15" fill="currentColor" />
    </svg>
  )
}

/** Type guard for the overview response body (`ok` flag + `overview` document). */
function isOverviewBody(body: unknown): body is { ok: boolean; overview: DashboardOverviewView } {
  return typeof body === 'object' && body !== null && 'ok' in body && 'overview' in body
}

/** Same-origin read of the host ledger overview; undefined on any failure. */
async function fetchOverview(): Promise<DashboardOverviewView | undefined> {
  try {
    const response = await fetch('/api/dashboard/overview', { headers: { accept: 'application/json' } })
    const body: unknown = await response.json()
    if (response.ok && isOverviewBody(body) && body.ok) return body.overview
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Client plugin body: register both panels, the brand slots, the usage
 * sidebar entry, the landing selection, and the stylesheet.
 * @param ctx - client root context.
 */
export function apply(ctx: DashboardContext): void {
  const sessions = tryGet<SessionsFace>(ctx, 'sessions')
  const layout = tryGet<{ selectPanel(panelId: string | null): void }>(ctx, 'layout')
  if (sessions === undefined || layout === undefined) return
  // Generated remote facades: per-session event tails and prompts, and the
  // structured user-question answerer. Either may be absent; both pages
  // degrade (status "working…", prompt-less reply path) without them.
  const sessionRemote = tryGet<SessionRemoteFace>(ctx, 'remote.session')
  const questionRemote = tryGet<QuestionRemoteFace>(ctx, 'remote.userQuestions')

  // The workspaces list powers the feed's grouping; absent, grouping falls
  // back to each session's cwd. Like uiWorkspace, the service may load after
  // this plugin applies — resolve lazily, retrying until it appears.
  let resolvedWorkspaces: WorkspacesFace | undefined
  const resolveWorkspaces = (): WorkspacesFace | undefined => {
    if (resolvedWorkspaces === undefined) resolvedWorkspaces = tryGet<WorkspacesFace>(ctx, 'workspaces')
    return resolvedWorkspaces
  }

  // Workspace panels register on first open (they are per-workspace), then
  // `layout.selectPanel` — the same programmatic open the usage panel uses.
  const workspacePanels = new Set<string>()

  const face: DashboardFace = {
    sessions,
    sessionRemote,
    questionRemote,
    get workspaces() { return resolveWorkspaces() },
    openDashboard: () => { layout.selectPanel(PANEL_ID) },
    openUsage: () => { layout.selectPanel(USAGE_PANEL_ID) },
    openWorkspace: (target: WorkspaceTarget) => {
      const panelId = `workspace-${target.slug}`
      if (workspacePanels.has(panelId)) {
        layout.selectPanel(panelId)
        return
      }
      workspacePanels.add(panelId)
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main', key: panelId,
          inject: () => ({ ...face, workspacePath: target.path, workspaceLabel: target.label, workspaceSlug: target.slug }),
        }, WorkspacePage)
        layout.selectPanel(panelId)
      })
    },
    // uiWorkspace loads after this plugin applies; resolve at click time.
    openSession: (sessionId) => { tryGet<{ openSession(target: string): void }>(ctx, 'uiWorkspace')?.openSession(sessionId) },
    fetchOverview,
    version: bootRelease()?.version,
  }

  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => face }, DashboardPage)
  }), 'dashboard: main panel')

  ctx.effect(() => ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: USAGE_PANEL_ID, inject: () => face }, UsagePage)
  }), 'dashboard: usage panel')

  ctx.effect(() => ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', key: PANEL_ID, priority: -1, inject: () => face }, BrandMark)
  ), 'dashboard: brand mark')

  ctx.effect(() => ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', key: PANEL_ID, priority: -1, inject: () => face }, BrandName)
  ), 'dashboard: brand name')

  // Sidebar entry so the usage page is reachable from any panel, mid-session
  // included (the whale always lands on the agents dashboard).
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: USAGE_PANEL_ID, order: 30, label: () => 'Usage statistics', inject: () => ({}) }, UsagePanelIcon)
  ), 'dashboard: usage sidebar entry')

  // Landing default: the panel store boots on the conversation; the
  // dashboard takes over for a fresh page. Opening a session resets the
  // selection back to the conversation (ui-workspace replaceMain).
  ctx.effect(() => {
    layout.selectPanel(PANEL_ID)
    return () => {}
  }, 'dashboard: landing selection')

  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dashboard'
    tag.dataset.pluginCss = 'dashboard/dashboard.css'
    tag.textContent = DASHBOARD_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dashboard: stylesheet')
}
