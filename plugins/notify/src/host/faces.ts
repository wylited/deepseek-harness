/**
 * Structural runtime faces notify consumes, typed locally so the plugin
 * carries no package dependency beyond the host that mounts it (same idiom
 * as plugins/keys' session-persistence faces). Shapes mirror
 * `@deepseek-ai/dsh-session` (events), `@deepseek-ai/dsh-api-session-controller`
 * (gateway presence), and `@deepseek-ai/dsh-credentials` (reference seam);
 * only the fields actually read are declared.
 * @module notify/host/faces
 */

/** Live Session subset: identity plus the header fields notify classifies on. */
export interface SessionLike {
  readonly id: string
  readonly header: {
    /** Absolute working directory the session was created in; names the workspace. */
    readonly cwd?: string
    /** `'subagent'` marks child sessions — never notified. */
    readonly origin?: string
  }
}

/** One committed Session log event envelope; payloads are owner-defined JSON. */
export interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

/** Text/content block subset of a model message (merge-extensible union). */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
}

/** Assistant message subset carried by `assistant/message`. */
export interface AssistantMessageLike {
  readonly content: readonly ContentBlockLike[]
}

/** Tool result subset carried by `tool/result` (pairs with `tool/call` by id). */
export interface ToolResultMessageLike {
  readonly toolCallId: string
}

/** Whether the gateway currently has a live, uncancelled owner client. */
export interface GatewayFace {
  hasLiveClient(): boolean
}

/** One resolved credential value and its source layer. */
export interface ResolvedCredentialLike {
  readonly value: string
  readonly source: string
}

/**
 * The credential seam's reference half. References are POSIX env names
 * (`[A-Za-z_][A-Za-z0-9_]*`); `credentialRef` is the host-side brand cast —
 * the provider re-validates the grammar at resolve time, so the plugin never
 * needs the brand package.
 */
export interface CredentialsFace {
  resolve(ref: string): Promise<ResolvedCredentialLike | undefined>
}

/** The one logger method set notify uses, via `ctx.logger('notify')`. */
export interface LoggerFace {
  warn(...args: readonly unknown[]): void
  info(...args: readonly unknown[]): void
  debug(...args: readonly unknown[]): void
}

/** Cordis event registration subset, narrowed to the session feed. */
export interface SessionEventsFace {
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void,
    options?: { global?: boolean }): () => void
  on(name: 'session/disposed', listener: (session: SessionLike) => void,
    options?: { global?: boolean }): () => void
}

/** A string-valued field read off an owner-defined JSON payload, narrowed. */
function stringField(data: object, key: string): string | undefined {
  if (!(key in data)) return undefined
  const value: unknown = (data as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Whether one raw event payload carries the `session/title` snapshot. */
export function asTitleEvent(data: unknown): { title: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const title = stringField(data, 'title')
  return title === undefined ? undefined : { title }
}

/** Whether one raw event payload carries a tool call, with its fields. */
export function asToolCall(data: unknown): {
  callId: string
  name: string
  arguments: string
} | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const callId = stringField(data, 'callId')
  const name = stringField(data, 'name')
  const args = stringField(data, 'arguments')
  if (callId === undefined || name === undefined || args === undefined) return undefined
  return { callId, name, arguments: args }
}

/** A nested object field read off an owner-defined JSON payload, narrowed. */
function objectField(data: object, key: string): object | undefined {
  if (!(key in data)) return undefined
  const value: unknown = (data as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null ? value : undefined
}

/** Whether one raw event payload carries a tool result, with its call id. */
export function asToolResult(data: unknown): { callId: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = objectField(data, 'message')
  if (message === undefined) return undefined
  const callId = stringField(message, 'toolCallId')
  return callId === undefined ? undefined : { callId }
}

/** Whether one raw event payload carries a turn end, with its reason kind. */
export function asTurnEnd(data: unknown): { turn: number; reasonKind: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const turnValue: unknown = 'turn' in data ? (data as Record<string, unknown>)['turn'] : undefined
  if (typeof turnValue !== 'number') return undefined
  const reason = objectField(data, 'reason')
  const reasonKind = reason === undefined ? undefined : stringField(reason, 'kind')
  if (reasonKind === undefined) return undefined
  return { turn: turnValue, reasonKind }
}

/** Whether one raw event payload carries an assistant message, with fields. */
export function asAssistantMessage(data: unknown): {
  turn: number
  message: AssistantMessageLike
} | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const turnValue: unknown = 'turn' in data ? (data as Record<string, unknown>)['turn'] : undefined
  if (typeof turnValue !== 'number') return undefined
  const message = objectField(data, 'message')
  const contentValue = message === undefined ? undefined
    : 'content' in message ? (message as Record<string, unknown>)['content'] : undefined
  if (!Array.isArray(contentValue)) return undefined
  const blocks = contentValue.filter((block): block is ContentBlockLike =>
    typeof block === 'object' && block !== null
    && stringField(block, 'type') === 'text')
  return { turn: turnValue, message: { content: blocks } }
}

/** Concatenated text-block content of one message, trimmed. */
export function messageText(message: AssistantMessageLike): string {
  return message.content
    .map(block => block.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
    .trim()
}
