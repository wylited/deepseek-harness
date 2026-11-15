/**
 * Idle status summaries and pending-question facts for the dashboard cards.
 * Pure layer: wire/report shapes shared by the host route and the browser
 * page, the aux-LLM prompt contract (executor pattern follows
 * `@deepseek-ai/dsh-session-title-llm`: bounded input, small output-token
 * cap, hard deadline, exact-route capture), the deterministic fallback, and
 * the strict revive of the persisted per-session summary cache.
 * @module dashboard/core/summary
 */

/** One pending `ask_user_question` call, host-reported for a session. */
export interface DashboardSummaryPending {
  /** The pending call's id, when the projection names one. */
  callId: string | undefined
  /** First open question's text (the batch can hold more). */
  question: string
}

/** One session's dashboard-relevant facts, served by the summaries route. */
export interface DashboardSummaryReport {
  sessionId: string
  /** Host-side agent running state (`ctx.agents`). */
  running: boolean
  /** Open user question at poll time; undefined when none is open. */
  pending: DashboardSummaryPending | undefined
  /** Cached idle status summary; undefined until first generated. */
  summary: string | undefined
}

/** The document `GET /api/dashboard/summaries` answers with. */
export interface DashboardSummariesBody {
  ok: boolean
  summaries: readonly DashboardSummaryReport[]
}

/** One persisted idle summary, keyed by session id in the ledger document. */
export interface SessionSummaryEntry {
  /** The generated (or fallback) summary text, at most two lines. */
  text: string
  /** Session seq the summary reflects; -1 when the log was unreadable. */
  asOfSeq: number
  /** Epoch ms the entry was written; staleness compare for cold sessions. */
  atMs: number
}

/** Entries kept per session; the oldest atMs prune past the cap. */
export const SUMMARY_ENTRY_CAP = 400

/** Output-token cap for the aux summary request (cheap by contract). */
export const SUMMARY_MAX_OUTPUT_TOKENS = 120

/** End-to-end aux request deadline in milliseconds. */
export const SUMMARY_TIMEOUT_MS = 15_000

/** UTF-16 code units of transcript fed to the aux request. */
export const SUMMARY_INPUT_CHARS = 3_000

/** User+assistant messages the transcript keeps (the most recent ones). */
export const SUMMARY_TURN_MESSAGES = 8

/** Character cap of the deterministic fallback (truncated last assistant). */
export const SUMMARY_FALLBACK_CHARS = 120

/** Systems prompt for the aux summary request. */
export const SUMMARY_SYSTEM = [
  'You write the status line of one card on a personal agent dashboard.',
  'Input is the tail of a coding-agent session transcript. Answer with exactly two short lines and nothing else:',
  'Line 1: what the session got done, in completed past phrasing ("Fixed the login redirect", never "Running…" or "Working on…").',
  'Line 2: what it is waiting on now, past or stative phrasing ("Awaited review of the patch", "Waiting on a reply about staging").',
  'At most 90 characters per line. No lists, no markdown, no quotes around the lines.',
].join('\n')

/** One transcript turn line: who said it and its flat text. */
export interface TurnMessage {
  role: 'user' | 'assistant'
  text: string
}

/** A string field of an owner-defined event payload. */
function dataString(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data === null || !(key in data)) return undefined
  const value: unknown = data[key]
  return typeof value === 'string' ? value : undefined
}

/** Flat text of one message-shaped payload's `content` (string or blocks). */
function messageText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('message' in data)) return undefined
  const message: unknown = data.message
  if (typeof message !== 'object' || message === null || !('content' in message)) return undefined
  const content: unknown = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content.flatMap(part => {
    if (typeof part !== 'object' || part === null) return []
    if (!('type' in part) || !('text' in part)) return []
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('\n')
}

/** Whether one `user/message` payload is a direct human prompt (not a synthetic notice). */
function isHumanUserMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || !('source' in data)) return false
  const source: unknown = data.source
  return typeof source === 'object' && source !== null && 'kind' in source && source.kind === 'user'
}

/** Trim one turn text to a single blank-free line, bounded. */
function turnLine(text: string, cap: number): string | undefined {
  const line = text.split('\n').map(part => part.trim()).filter(part => part !== '').join(' ')
  if (line === '') return undefined
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line
}

/**
 * Extract the most recent human prompts and assistant replies from an event
 * list (any order: the input is read forward, the last
 * {@link SUMMARY_TURN_MESSAGES} extractions win). Payloads stay
 * owner-defined JSON and are walked with shape guards; anything unreadable
 * is skipped.
 */
export function turnMessagesOfEvents(events: readonly unknown[]): TurnMessage[] {
  const messages: TurnMessage[] = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null || !('type' in event) || !('data' in event)) continue
    const { type, data } = event as { type: unknown; data: unknown }
    if (type === 'user/message') {
      if (!isHumanUserMessage(data)) continue
      const line = turnLine(messageText(data) ?? '', 200)
      if (line !== undefined) messages.push({ role: 'user', text: line })
    } else if (type === 'assistant/message') {
      const line = turnLine(messageText(data) ?? '', 200)
      if (line !== undefined) messages.push({ role: 'assistant', text: line })
    }
  }
  return messages.slice(-SUMMARY_TURN_MESSAGES)
}

/** The aux request's user input: the bounded transcript tail. */
export function composeSummaryInput(messages: readonly TurnMessage[]): string {
  const lines = messages.map(message => `${message.role}: ${message.text}`)
  let text = lines.join('\n')
  if (text.length > SUMMARY_INPUT_CHARS) text = text.slice(text.length - SUMMARY_INPUT_CHARS)
  return `Session transcript tail (oldest first):\n${text}\n\nWrite the two-line card status now.`
}

/** The last assistant text of an event list, for the deterministic fallback. */
export function lastAssistantTextOfEvents(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (typeof event !== 'object' || event === null || !('type' in event) || !('data' in event)) continue
    const { type, data } = event as { type: unknown; data: unknown }
    if (type !== 'assistant/message') continue
    const line = turnLine(messageText(data) ?? '', SUMMARY_FALLBACK_CHARS)
    if (line !== undefined) return line
  }
  return undefined
}

/**
 * Deterministic fallback when the aux route or LLM is unavailable: the
 * session's last assistant words, truncated. Undefined without any.
 */
export function fallbackSummary(lastAssistant: string | undefined): string | undefined {
  return lastAssistant
}

/** First open question of a session, from its `userQuestions` projection values. */
export function pendingOfProjectionValues(values: Record<string, unknown> | undefined): DashboardSummaryPending | undefined {
  if (values === undefined) return undefined
  const view: unknown = values['userQuestions']
  if (typeof view !== 'object' || view === null || !('active' in view)) return undefined
  const active: unknown = view.active
  if (!Array.isArray(active)) return undefined
  for (const item of active) {
    if (typeof item !== 'object' || item === null || !('questions' in item)) continue
    if (!Array.isArray(item.questions)) continue
    const callId = 'callId' in item && typeof item.callId === 'string' ? item.callId : undefined
    for (const question of item.questions) {
      if (typeof question !== 'object' || question === null) continue
      if (!('question' in question) || typeof question.question !== 'string') continue
      return { callId, question: question.question }
    }
    return { callId, question: 'awaiting your answer' }
  }
  return undefined
}

/**
 * Parse the persisted summary map from untrusted JSON: unknown shapes drop
 * to an empty map, malformed entries are dropped, the oldest entries beyond
 * {@link SUMMARY_ENTRY_CAP} are pruned. Never throws.
 */
export function reviveSummaryEntries(value: unknown): Record<string, SessionSummaryEntry> {
  const entries: Record<string, SessionSummaryEntry> = {}
  if (typeof value !== 'object' || value === null) return entries
  for (const [sessionId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') continue
    if (typeof raw !== 'object' || raw === null) continue
    const source = raw as Record<string, unknown>
    if (typeof source.text !== 'string' || source.text === '') continue
    if (typeof source.asOfSeq !== 'number' || !Number.isFinite(source.asOfSeq)) continue
    if (typeof source.atMs !== 'number' || !Number.isFinite(source.atMs)) continue
    entries[sessionId] = {
      text: source.text,
      asOfSeq: source.asOfSeq,
      atMs: source.atMs,
    }
  }
  return pruneSummaryEntries(entries, SUMMARY_ENTRY_CAP)
}

/** Drop the oldest-atMs entries beyond `cap`, in place. Returns the same map. */
export function pruneSummaryEntries(
  entries: Record<string, SessionSummaryEntry>,
  cap: number,
): Record<string, SessionSummaryEntry> {
  const ids = Object.keys(entries)
  if (ids.length <= cap) return entries
  const ordered = ids.sort((left, right) => entries[left]!.atMs - entries[right]!.atMs)
  for (const id of ordered.slice(0, ids.length - cap)) delete entries[id]
  return entries
}

/** Clean model output into the at-most-two-line card text. */
export function cleanSummaryText(raw: string): string {
  const lines = raw
    .split('\n')
    .map(line => line.trim().replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))
    .filter(line => line !== '' && !/^line\s*\d/i.test(line))
    .slice(0, 2)
    .map(line => (line.length > 120 ? `${line.slice(0, 119)}…` : line))
  return lines.join('\n')
}
