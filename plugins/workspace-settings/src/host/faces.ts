/**
 * Structural runtime faces workspace-settings consumes, typed locally so the
 * plugin carries no package dependency beyond the host that mounts it (the
 * same idiom as plugins/notify's host/faces). Shapes mirror
 * `@deepseek-ai/dsh-workspace` (registry), `@deepseek-ai/dsh-agent` +
 * `@deepseek-ai/dsh-agent-loop` (announced agents), `@deepseek-ai/dsh-tools`
 * (registry view), and `@deepseek-ai/dsh-host-webserver` (route table); only
 * the fields actually read are declared.
 * @module workspace-settings/host/faces
 */

/** One registry workspace: identity, canonical directory, display title. */
export interface WorkspaceSummary {
  readonly id: string
  readonly path: string
  readonly title: string
}

/**
 * The workspace registry (`ctx.workspaceRegistry`). `resolveByPath` is the
 * path→workspace lookup (realpath-normalizes the candidate and compares
 * against each entity's canonical path); `list` is the durable registry
 * order; `get` is the id-based existence check.
 */
export interface WorkspaceRegistryFace {
  list(): readonly WorkspaceSummary[]
  get(id: string): object | undefined
  resolveByPath(path: string): Promise<WorkspaceSummary | undefined>
}

/** Live Session subset: identity, header classification, and log freshness. */
export interface SessionFace {
  readonly id: string
  readonly header: {
    /** Absolute working directory the session was created in; names the workspace. */
    readonly cwd?: string
    /** `'subagent'` marks child sessions — never enforced against. */
    readonly origin?: string
  }
  /** Log length at construction: 0 only for a freshly created Session. */
  readonly firstLiveSeq: number
  /** The committed event at one log position, or `undefined` past the end. */
  eventAt(seq: number): { readonly type: string } | undefined
}

/** One visible tool definition (`ctx.tools.schemas(agent)` element). */
export interface ToolSchemaLike {
  readonly name: string
}

/**
 * A live announced Agent (the `agent/created` payload's `agent`). The runtime
 * object exposes more than the public `{ id }` interface; only the surfaces
 * enforcement reads are declared — the session, the agent's own scoped
 * context (its tools view, which admits `restrict`), and the model selection.
 */
export interface AgentLike {
  readonly id: string
  readonly session: SessionFace
  readonly ctx: {
    readonly tools: {
      schemas(agent: object): readonly ToolSchemaLike[]
      /** Scoped tool mask; requires a scoped context (the agent's own is). */
      restrict(filter: { readonly deny?: readonly string[] }): () => void
    }
  }
  readonly model: {
    /** Session-scoped model selection (no deployment-default side effect). */
    select(selection: { provider: string; model: string; reasoningEffort?: string }): void
  }
}

/** The one logger method set this plugin uses, via `ctx.logger(…)`. */
export interface LoggerFace {
  warn(...args: readonly unknown[]): void
  info(...args: readonly unknown[]): void
}

/** Cordis event registration subset, narrowed to the events enforcement uses. */
export interface EventsFace {
  on(name: 'agent/created', listener: (payload: { agent: AgentLike }) => void | Promise<void>,
    options?: { global?: boolean }): () => void
  on(name: 'agent/disposed', listener: (payload: { agent: AgentLike }) => void,
    options?: { global?: boolean }): () => void
  on(name: 'tools/change', listener: () => void, options?: { global?: boolean }): () => void
}

/** The plugin fiber's context subset: services, events, and effect disposal. */
export interface PluginContextFace extends EventsFace {
  logger(name: string): LoggerFace
  get(name: string): unknown
  effect(dispose: () => void, label?: string): unknown
}

/** The web server's route table (`ctx.webServer`). */
export interface WebServerFace {
  register(route: unknown): (() => void) | undefined
}
