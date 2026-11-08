/**
 * The per-workspace sub-dashboard (panel id `workspace-<slug>`): the
 * workspace's own sessions with live status tails and the landing's inline
 * answer boxes, then its child workspaces (git worktrees, `.dsh-work` temp
 * workspaces) as collapsible groups. Opened by clicking a workspace header
 * on the landing feed or a child name here; `← Dashboard` returns to the
 * landing.
 * @module dashboard/client/WorkspacePage
 */

import { useMemo, useState, useSyncExternalStore } from 'react'
import {
  FeedItem, WorkspaceGroup, pendingQuestionOf, useNowTicker, type DashboardFace,
} from './DashboardPage.tsx'
import {
  buildWorkspaceGroups, findGroupNode, projectRows, useOptionalStore, workspaceKey,
  type WorkspaceGroupNode,
} from './workspace.ts'

/** Panel props: the shared face plus the workspace this panel names. */
export interface WorkspacePanelProps extends DashboardFace {
  workspacePath: string
  workspaceLabel: string
  workspaceSlug: string
}

/** The per-workspace panel body. */
export function WorkspacePage(props: WorkspacePanelProps) {
  const state = useSyncExternalStore(props.sessions.list.subscribe, props.sessions.list.getSnapshot)
  const workspaces = useOptionalStore(props.workspaces?.list)
  const now = useNowTicker(30_000)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  // The whole session set folds once (archived sessions excluded); this
  // panel renders the node naming its own path — its own sessions plus the
  // child workspaces beneath it, each with the landing's live rows.
  const groups = useMemo(
    () => buildWorkspaceGroups(
      projectRows(state, workspaces.items)
        .filter(row => !workspaces.archivedSessionIds.includes(row.sessionId)),
      workspaces.items,
      { childOf: props.workspacePath },
    ),
    [state, workspaces, props.workspacePath],
  )
  const node: WorkspaceGroupNode | undefined = findGroupNode(groups.roots, props.workspacePath)

  const toggle = (key: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const running = node?.rows.filter(row => row.running).length ?? 0
  return (
    <div className="wd-page">
      <header className="wd-header">
        <h1 className="wd-title">{props.workspaceLabel}</h1>
        <span className="wd-header-path" title={props.workspacePath}>{props.workspacePath}</span>
        <span className="wd-header-spring" />
        <button type="button" className="wd-navbtn" onClick={props.openDashboard}>← Dashboard</button>
      </header>
      <section className="wd-section">
        <div className="wd-section-head">
          <h2 className="wd-section-title">Sessions</h2>
          <span className="wd-section-note">
            {running > 0 ? `${running} running · click a row to open` : 'click a row to open'}
          </span>
        </div>
        {node === undefined || node.rows.length === 0
          ? <div className="wd-empty">No sessions in this workspace yet.</div>
          : (
            <div className="wd-feed">
              {node.rows.map(row => (
                <FeedItem
                  key={row.sessionId}
                  row={row}
                  now={now}
                  face={props}
                  question={pendingQuestionOf(state.projectionsBySession[row.sessionId]?.values)}
                />
              ))}
            </div>
          )}
      </section>
      {node !== undefined && node.children.length > 0 && (
        <section className="wd-section">
          <div className="wd-section-head">
            <h2 className="wd-section-title">Child workspaces</h2>
            <span className="wd-section-note">a name opens its page</span>
          </div>
          <div className="wd-group-kids">
            {node.children.map(child => (
              <WorkspaceGroup
                key={workspaceKey(child)}
                node={child}
                depth={1}
                now={now}
                face={props}
                state={state}
                collapsed={collapsed.has(workspaceKey(child))}
                collapsedSet={collapsed}
                onToggle={toggle}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
