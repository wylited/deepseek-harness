/**
 * Enforcement: resolves each fresh top-level session's workspace by cwd and
 * applies that workspace's settings at creation time.
 *
 * Subscription follows the `agent/created` idiom of
 * packages/subagent/tool-subagent/src/model-selection-settings.ts (with
 * notify's plugin-side `{ global: true }` registration so a plugin fiber
 * hears the scoped per-agent carriers). The freshness check is copied
 * verbatim: a session is fresh when `origin !== 'subagent'`,
 * `firstLiveSeq === 0`, and the log head is not a `session/end-seed` marker.
 *
 * Applied settings:
 * - `sandboxMode` — the canonical write path `setSandboxMode` (the function,
 *   not a re-implementation), appending the session's `sandbox/mode` override.
 * - `provider`+`model` (+`reasoningEffort`) — `agent.model.select(...)` on the
 *   announced agent: session-scoped, unlike session-controller's selectModel
 *   it performs no deployment-default save.
 * - `mcpServers` — a deny-mask over `mcp__<server>__*` tools (the
 *   browser-use-runtime mask idiom) via the agent's own scoped tools view;
 *   re-applied coalesced on `tools/change` when new MCP tools register.
 *
 * `agentPreset` is stored and served but not yet enforced — presets bind at
 * session creation through the session-controller, which this plugin does not
 * intercept.
 *
 * @module workspace-settings/host/apply
 */

// The canonical sandbox-mode write path, imported from source so the plugin
// never re-states the event contract. The module's only imports are
// type-only, so bundling it adds no runtime dependency (the parameter casts
// below bridge the plugin's structural faces to the branded package types).
import { setSandboxMode } from '../../../../packages/sandbox/sandbox-policy/src/session-mode.ts'
import type { AgentLike, LoggerFace, PluginContextFace, WorkspaceRegistryFace } from './faces.ts'
import { loadSettings } from './store.ts'

/** Enforcement dependencies resolved by the plugin entry. */
export interface EnforcementDeps {
  /** Settings home (`$DSH_HOME`). */
  homePath: string
  /** Workspace registry for the cwd→workspace resolution. */
  registry: WorkspaceRegistryFace
  /** The tools registry (`ctx.tools`), for the MCP mask; absent = no masking. */
  tools: { schemas(agent: object): readonly { name: string }[] } | undefined
  /** Whether the `sandboxPolicy` service is mounted; absent = sandbox never applied. */
  sandboxPolicyReady: boolean
  /** Failure logging. */
  logger: LoggerFace
}

/** One tracked agent's allowlist and live mask. */
interface TrackedMask {
  allow: ReadonlySet<string>
  deny: readonly string[]
  dispose?: () => void
}

/** The MCP server named by a tool name (`mcp__<server>__<tool>`), or `undefined`. */
function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')
  return cut === -1 ? rest : rest.slice(0, cut)
}

const sameDeny = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, index) => name === right[index])

/**
 * Wire the session-feed enforcement onto the plugin context.
 * @returns the full disposer (feed listeners, pending recheck, live masks).
 */
export function wireEnforcement(ctx: PluginContextFace, deps: EnforcementDeps): () => void {
  /** Agents whose workspace masks MCP servers, keyed by the agent object. */
  const tracked = new Map<object, TrackedMask>()

  /** Re-apply one agent's mask only when the denied set actually changed (a swap re-emits tools/change). */
  const applyMask = (agent: AgentLike, state: TrackedMask): void => {
    if (deps.tools === undefined) return
    let names: readonly { name: string }[]
    try {
      names = deps.tools.schemas(agent)
    } catch {
      return
    }
    const denied: string[] = []
    for (const tool of names) {
      const server = mcpServerOf(tool.name)
      if (server !== undefined && !state.allow.has(server)) denied.push(tool.name)
    }
    if (sameDeny(state.deny, denied)) return
    state.dispose?.()
    state.dispose = undefined
    state.deny = denied
    if (denied.length === 0) return
    try {
      state.dispose = agent.ctx.tools.restrict({ deny: denied })
    } catch (error) {
      deps.logger.warn(`workspace-settings: mcp mask failed for session "${agent.id}": ${String(error)}`)
    }
  }

  /** Coalesced mask refresh when the tools registry changes. */
  let recheckQueued = false
  const recheckAll = (): void => {
    recheckQueued = false
    for (const [agent, state] of tracked) applyMask(agent, state)
  }

  const onCreated = async (agent: AgentLike): Promise<void> => {
    const session = agent.session
    if (session.header.origin === 'subagent') return
    if (session.firstLiveSeq !== 0) return
    // Freshness parity with model-selection-settings.ts:71-75 — a seed marker
    // at the log head means the session was not freshly created here.
    if (session.eventAt(0)?.type === 'session/end-seed') return
    const cwd = session.header.cwd
    if (cwd === undefined) return
    const workspace = await deps.registry.resolveByPath(cwd).catch(() => undefined)
    if (workspace === undefined) return
    const settings = loadSettings(deps.homePath, workspace.id)
    if (settings.sandboxMode !== undefined) {
      if (deps.sandboxPolicyReady) {
        try {
          setSandboxMode(
            session as unknown as Parameters<typeof setSandboxMode>[0],
            settings.sandboxMode as unknown as Parameters<typeof setSandboxMode>[1],
          )
        } catch (error) {
          deps.logger.warn(
            `workspace-settings: sandbox mode "${settings.sandboxMode}" not applied to session "${session.id}": ${String(error)}`,
          )
        }
      } else {
        deps.logger.warn(
          `workspace-settings: workspace "${workspace.id}" sets sandboxMode but no sandboxPolicy service is mounted`,
        )
      }
    }
    if (settings.provider !== undefined && settings.model !== undefined) {
      try {
        agent.model.select({
          provider: settings.provider,
          model: settings.model,
          ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
        })
      } catch (error) {
        deps.logger.warn(
          `workspace-settings: model ${settings.provider}/${settings.model} not selected for session "${session.id}": ${String(error)}`,
        )
      }
    }
    if (settings.mcpServers !== undefined && deps.tools !== undefined) {
      const state: TrackedMask = { allow: new Set(settings.mcpServers), deny: [] }
      tracked.set(agent, state)
      applyMask(agent, state)
    }
  }

  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    void onCreated(agent).catch((error: unknown) => {
      deps.logger.warn(`workspace-settings: session start enforcement failed: ${String(error)}`)
    })
  }, { global: true })
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    // The restriction lives on the agent's own scope and dies with it; only
    // the tracking entry (which strongly references the agent) must go.
    tracked.delete(agent)
  }, { global: true })
  const disposeChange = ctx.on('tools/change', () => {
    if (recheckQueued) return
    recheckQueued = true
    queueMicrotask(recheckAll)
  }, { global: true })

  return () => {
    disposeCreated()
    disposeDisposed()
    disposeChange()
    if (recheckQueued) recheckQueued = false
    for (const state of tracked.values()) state.dispose?.()
    tracked.clear()
  }
}
