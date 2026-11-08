/**
 * keys, browser half. Four jobs:
 *
 * 1. Command palette (Cmd/Ctrl+P) — a self-contained modal: the fork's commands,
 *    settings/composer affordances, and free-text slash passthrough into the
 *    composer (native slash autocomplete takes over there). Handrolled because
 *    the ecosystem palette (@dsh-community 0.1.0-alpha.0) imports a settings
 *    API that no longer exists on dsh 0.2.2-rc.1. Filtering is fuzzy
 *    (subsequence match, ranked by keyword hits), the last-executed commands
 *    float to the top, and the modal animates open/closed.
 * 2. Global search (Cmd/Ctrl+K) — the same modal in a search mode: workspace
 *    labels, session titles, and host-backed full-text over message
 *    transcripts (`sessions.search`, the Host's message-content index),
 *    grouped under muted headers and navigated with the palette's bindings.
 *    dsh's own session-search shortcut is Cmd/Ctrl(+Alt)+K; the capture-phase
 *    listener below intercepts the chord before the native dispatcher's
 *    bubble-phase handler runs (the same override path Cmd+P uses).
 * 3. Alt+T — cycle the current session's thinking level off→low→high→max.
 * 4. Everything degrades gracefully: every service is optional-injected.
 *
 * All user-tunable values (keybinds, defaults, selectors, timings) live in
 * CONFIG below — see README.md for the full list and how to apply changes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

export const CONFIG = {
  /** Cmd/Ctrl + this key toggles the palette. */
  paletteKey: 'p',
  /** Cmd/Ctrl + this key opens the same modal in global search mode (workspaces,
   *  sessions, message text). dsh natively binds Cmd/Ctrl+K (desktop) and
   *  Cmd/Ctrl+Alt+K (web) to its sidebar session search; the window-capture
   *  listener intercepts the plain chord before that dispatcher's bubble-phase
   *  handler runs, and the native Alt variant still works. */
  searchKey: 'k',
  /** Debounce before a keystroke queries the host message index. */
  searchDebounceMs: 150,
  /** Result caps for the search mode's client-side corpora. Messages are
   *  capped host-side (`sessions.searchResultLimit` = 20). */
  searchWorkspaceCap: 8,
  searchSessionCap: 12,
  /** Alt + this key cycles the thinking level. Not Cmd+Tab: macOS captures
   *  it for app switching before the page ever sees the event (README). */
  cyclerKey: 't',
  /** Thinking levels the cycler walks through, in order. */
  cycleOrder: ['off', 'low', 'high', 'max'],
  /** Fork default route: zcode/glm-5.3-flashx (agent-default-model row). */
  defaultProvider: 'zcode',
  defaultModel: 'glm-5.3-flashx',
  /** dsh's default effort when a session never picked one (llm-pi-ai route default). */
  seedEffort: 'high',
  /** Recently-run command ids kept in localStorage, floated to the top. */
  recencyCap: 5,
  recencyStorageKey: 'keys.palette.recent',
  /** Open/close animation length (transform + opacity). */
  animationMs: 120,
  /** How often the input placeholder advances to the next headline action. */
  placeholderRotateMs: 3200,
  /** DOM hooks into the host shell — update these if the shell changes.
   *  The composer is a contenteditable (ComposerContentEditable) tagged
   *  data-composer-input; the old `[data-composer-card] textarea` spelling
   *  matched nothing. */
  settingsTriggerSelector: '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]',
  composerInputSelector: '[data-composer-card] [data-composer-input]',
} as const

type Effort = (typeof CONFIG.cycleOrder)[number]

const lastEffortBySession = new Map<string, Effort>()

interface KeysContext extends ClientContext {
  get(name: string): unknown
}

function tryGet<T>(ctx: KeysContext, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

// --- toast ---------------------------------------------------------------

let toastEl: HTMLDivElement | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined

function toast(text: string): void {
  if (toastEl === undefined) {
    toastEl = document.createElement('div')
    toastEl.dataset.plugin = 'keys-toast'
    toastEl.style.cssText =
      'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);' +
      'z-index:99999;padding:10px 18px;background:#ff9940;color:#1a1a1a;' +
      'font-family:var(--dsw-font-family-text,system-ui),sans-serif;font-size:13px;' +
      'font-weight:700;border-radius:0;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
      'opacity:0;transition:opacity .15s ease;pointer-events:none;white-space:nowrap'
    document.body.append(toastEl)
  }
  toastEl.textContent = text
  toastEl.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (toastEl !== undefined) toastEl.style.opacity = '0'
  }, 1600)
}

// --- actions ---------------------------------------------------------------

interface Selection {
  provider: string
  model: string
  reasoningEffort: Effort
}

/** Current selection: durable projection first, our memory second, seed last. */
function currentSelection(ctx: KeysContext, sessionId: string | undefined): Selection {
  const dirs = tryGet<{
    directoryFor(id: string): { store: { getSnapshot(): { current: Selection | null } } }
  }>(ctx, 'modelDirectories')
  if (sessionId !== undefined && dirs !== undefined) {
    try {
      const current = dirs.directoryFor(sessionId).store.getSnapshot().current
      if (current !== null && typeof current.reasoningEffort === 'string') {
        const effort = ((CONFIG.cycleOrder as readonly string[]).includes(current.reasoningEffort)
          ? current.reasoningEffort
          : CONFIG.seedEffort) as Effort
        return { provider: current.provider, model: current.model, reasoningEffort: effort }
      }
    } catch {
      // directory not resolvable for this session — fall through to memory
    }
  }
  const effort = (sessionId !== undefined ? lastEffortBySession.get(sessionId) : undefined) ?? CONFIG.seedEffort
  return { provider: CONFIG.defaultProvider, model: CONFIG.defaultModel, reasoningEffort: effort }
}

async function cycleThinking(ctx: KeysContext): Promise<void> {
  const scoped = tryGet<{
    sessionId?: string
    selectModel(input: { provider: string; model: string; reasoningEffort: string }): Promise<unknown>
  }>(ctx, 'remote.session')
  if (scoped === undefined) {
    toast('thinking cycler unavailable (no session remote)')
    return
  }
  const sessionId = scoped.sessionId
  const sel = currentSelection(ctx, sessionId)
  const effort = nextEffort(sel.reasoningEffort)
  try {
    await scoped.selectModel({ provider: sel.provider, model: sel.model, reasoningEffort: effort })
  } catch (error) {
    toast(`model switch failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (sessionId !== undefined) lastEffortBySession.set(sessionId, effort)
  toast(`thinking: ${effort}  ·  ${sel.model}`)
}

function nextEffort(effort: Effort): Effort {
  const i = CONFIG.cycleOrder.indexOf(effort)
  return CONFIG.cycleOrder[(i + 1) % CONFIG.cycleOrder.length] as Effort
}

async function newTempSession(ctx: KeysContext): Promise<void> {
  const ui = tryGet<{ createDirectory(path: string, name: string): Promise<string>; startSession(workspaceId?: string): void }>(ctx, 'uiWorkspace')
  const spaces = tryGet<{ create(input: { path: string }): Promise<{ workspaceId: string }> }>(ctx, 'workspaces')
  const scoped = tryGet<{
    selectModel(input: { provider: string; model: string; reasoningEffort: string }): Promise<unknown>
  }>(ctx, 'remote.session')
  if (ui === undefined || spaces === undefined) {
    toast('new temp session unavailable (missing workspace services)')
    return
  }
  // Fresh scratch dir when the directory picker composes the browse
  // capability; hosts serving only the native picker reject programmatic
  // createDirectory, so fall back to a session in the shared /tmp workspace.
  let path = '/tmp'
  try {
    path = await ui.createDirectory('/tmp', `dsh-wyli-${Date.now().toString(36)}`)
  } catch {
    // browse capability absent — /tmp itself is the scratch space
  }
  const view = await spaces.create({ path })
  ui.startSession(view.workspaceId)
  if (scoped !== undefined) {
    try {
      await scoped.selectModel({
        provider: CONFIG.defaultProvider,
        model: CONFIG.defaultModel,
        reasoningEffort: 'off',
      })
    } catch {
      // the default model already matches; effort pins on the next step when possible
    }
  }
  toast(`new session · ${path} · flashx · thinking off`)
}

/** Switch the workspace layout to a panel registered by another plugin. */
function selectLayoutPanel(ctx: KeysContext, panelId: string, label: string): void {
  const layout = tryGet<{ selectPanel(id: string | null): void }>(ctx, 'layout')
  if (layout === undefined) {
    toast(`${label} unavailable (no layout service)`)
    return
  }
  try {
    layout.selectPanel(panelId)
  } catch {
    toast(`${label} panel is not registered (plugin missing or not loaded)`)
  }
}

function openSettings(): void {
  const trigger = document.querySelector(CONFIG.settingsTriggerSelector)
  if (trigger === null) {
    toast('settings unavailable (plugin not loaded or structure changed)')
    return
  }
  ;(trigger as HTMLElement).click()
}

function focusComposer(): void {
  const input = document.querySelector(CONFIG.composerInputSelector)
  if (input === null) {
    toast('composer not found')
    return
  }
  ;(input as HTMLElement).focus()
}

/** Insert the raw text into the composer and focus it (slash passthrough). */
function composerInsert(text: string): void {
  const input = document.querySelector(CONFIG.composerInputSelector)
  if (input === null || !(input instanceof HTMLElement)) {
    toast('composer not found')
    return
  }
  input.focus()
  // The composer is a contenteditable: park the caret at the end and insert
  // through execCommand so the edit rides the editor's input pipeline
  // (Lexical); a value/textContent write would desync it.
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(input)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
  document.execCommand('insertText', false, `${text} `)
}

// --- global search (Cmd+K) --------------------------------------------------

/** Which personality the shared modal is in. */
type PaletteMode = 'commands' | 'search'

/** Fields the fuzzy matcher scores (commands and search hits share the shape). */
interface FuzzyFields {
  readonly title: string
  readonly subtitle?: string
  readonly keywords: readonly string[]
}

/** One selectable row of search-mode results. */
interface SearchHit {
  readonly title: string
  readonly subtitle: string
  run(ctx: KeysContext): void | Promise<void>
}

/** Search-mode rows: selectable hits plus the muted group headers between them. */
type SearchRow = { readonly type: 'header'; readonly label: string }
  | { readonly type: 'note'; readonly text: string }
  | { readonly type: 'hit'; readonly hit: SearchHit }

/** Minimal runtime face of the client `sessions` service (see
 *  `packages/api/session-controller/src/client/contract/sessions.ts`). */
interface SessionsFace {
  list: {
    subscribe(fn: () => void): () => void
    getSnapshot(): SessionsListState
  }
  search(query: string, signal: AbortSignal): Promise<SearchRemoteResult>
}

/** The list snapshot fields search mode reads. */
interface SessionRow {
  readonly id: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
}

interface SessionsListState {
  readonly ids: readonly string[]
  readonly byId: Record<string, SessionRow>
}

/** The `sessions.search` result, widened to tolerate transport drift. */
type SearchRemoteResult =
  | { ok: true; value: { items: readonly { sessionId: string; snippet: string }[]; hasMore: boolean } }
  | { ok: false }

/** Workspace basenames that read as noise (this repo's checkout dir): the
 *  parent directory names the workspace more usefully. Forked from
 *  plugins/dashboard's `neutralBase` so both plugins label alike. */
const NOISY_BASENAME = 'dsh'

/** A workspace path's usable label: its basename, unless that is the bare
 *  repo dir (`dsh`), in which case the parent directory speaks instead. */
function workspaceLabelOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const segments = cwd.replace(/\/+$/, '').split('/')
  const base = segments[segments.length - 1]
  if (base === undefined || base === '') return undefined
  if (base.toLowerCase() !== NOISY_BASENAME) return base
  return segments.length > 2 ? segments[segments.length - 2] : undefined
}

/** Layout panel id for a workspace label (shared `workspace-<slug>` convention:
 *  displayLabel lowercased, non-alnum runs folded to '-'). */
function workspacePanelId(label: string): string {
  return `workspace-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/** Compact last-activity stamp for session rows. */
function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  if (!Number.isFinite(delta) || delta < 0) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toISOString().slice(0, 10)
}

/** Open a session by id through the workspace navigation service. */
function openSessionById(ctx: KeysContext, sessionId: string): void {
  const ui = tryGet<{ openSession(target: string): void }>(ctx, 'uiWorkspace')
  if (ui === undefined) {
    toast('opening sessions unavailable (no uiWorkspace service)')
    return
  }
  try {
    ui.openSession(sessionId)
  } catch {
    toast('could not open the session')
  }
}

/**
 * Navigate to a workspace: its dashboard panel when the layout has registered
 * one (same programmatic panel-open the usage command uses), else the most
 * recent session in that workspace.
 */
function runWorkspaceHit(ctx: KeysContext, label: string, sessionId: string | undefined): void {
  const layout = tryGet<{ selectPanel(id: string): void }>(ctx, 'layout')
  if (layout !== undefined) {
    try {
      layout.selectPanel(workspacePanelId(label))
      return
    } catch {
      // no `workspace-<slug>` panel registered — fall through to the session
    }
  }
  if (sessionId !== undefined) {
    openSessionById(ctx, sessionId)
    return
  }
  toast(`workspace “${label}” has no openable panel or session`)
}

// --- palette ---------------------------------------------------------------

interface PaletteCommand {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  readonly keywords: readonly string[]
  run(ctx: KeysContext): void | Promise<void>
}

const COMMANDS: readonly PaletteCommand[] = [
  {
    id: 'new-temp',
    title: 'New session · temp workspace',
    subtitle: 'zcode / glm-5.3-flashx · thinking off',
    keywords: ['new', 'temp', 'tmp', 'scratch', 'throwaway', 'quick', 'flashx', 'session'],
    run: (ctx) => newTempSession(ctx),
  },
  {
    id: 'dashboard',
    title: 'Open dashboard',
    subtitle: 'agents · usage · heatmap',
    keywords: ['dashboard', 'home', 'stats', 'usage', 'agents'],
    run: (ctx) => selectLayoutPanel(ctx, 'dashboard', 'dashboard'),
  },
  {
    id: 'usage-stats',
    title: 'Open usage statistics',
    subtitle: 'tokens · sessions · spend',
    keywords: ['usage', 'stats', 'statistics', 'tokens', 'spend', 'meter'],
    run: (ctx) => selectLayoutPanel(ctx, 'usage-stats', 'usage statistics'),
  },
  {
    id: 'cycle-thinking',
    title: 'Cycle thinking level',
    subtitle: 'off → low → high → max (Alt+T)',
    keywords: ['thinking', 'effort', 'reasoning', 'cycle', 'model'],
    run: (ctx) => cycleThinking(ctx),
  },
  {
    id: 'open-settings',
    title: 'Open settings',
    keywords: ['settings', 'preferences', 'config'],
    run: () => openSettings(),
  },
  {
    id: 'focus-composer',
    title: 'Focus composer',
    keywords: ['focus', 'composer', 'input', 'chat'],
    run: () => focusComposer(),
  },
]

/** Rotating input placeholder: the palette's three headline actions. */
const PLACEHOLDERS: readonly string[] = [
  'Try “new session · temp workspace”  —  /text sends to the composer',
  'Try “open dashboard”  —  agents · usage · heatmap',
  'Try “open usage statistics” or Alt+T to cycle thinking',
]

const PALETTE_CSS = `
[data-plugin="keys-palette"] {
  position: fixed; inset: 0; z-index: 99998;
  background: var(--dsw-alias-bg-overlay, rgba(0,0,0,.35));
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 14vh;
  font-family: var(--dsw-font-family-text, system-ui), sans-serif;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity ${CONFIG.animationMs}ms ease, visibility 0s linear ${CONFIG.animationMs}ms;
}
[data-plugin="keys-palette"][data-open="true"] {
  opacity: 1; visibility: visible; pointer-events: auto;
  /* visibility flips at 0s here: a transitioning visibility stays 'hidden'
     until ~50% progress, and focus() on a hidden element is a silent no-op —
     the palette input must be focusable the instant it opens. */
  transition: opacity ${CONFIG.animationMs}ms ease, visibility 0s;
}
[data-plugin="keys-palette"] .kp-panel {
  width: min(620px, 92vw); background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  border-radius: 0; box-shadow: 0 12px 40px rgba(0,0,0,.22); overflow: hidden;
  transform: translateY(-10px) scale(.98);
  transition: transform ${CONFIG.animationMs}ms ease;
}
[data-plugin="keys-palette"][data-open="true"] .kp-panel { transform: translateY(0) scale(1); }
@media (prefers-reduced-motion: reduce) {
  [data-plugin="keys-palette"], [data-plugin="keys-palette"] .kp-panel { transition: none; }
}
[data-plugin="keys-palette"] .kp-input {
  width: 100%; box-sizing: border-box; border: 0; outline: 0; border-radius: 0;
  padding: 13px 16px; font-size: 15px; color: var(--dsw-alias-label-primary, #5c6166);
  background: var(--dsw-alias-bg-base, #fafafa);
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7e8);
  font-family: var(--dsw-font-family-text, system-ui), sans-serif;
}
[data-plugin="keys-palette"] .kp-list { max-height: 46vh; overflow-y: auto; }
[data-plugin="keys-palette"] .kp-item {
  padding: 9px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  color: var(--dsw-alias-label-primary, #5c6166);
}
[data-plugin="keys-palette"] .kp-item[data-selected="true"] {
  background: var(--dsw-alias-bg-layer-2, #f3f4f5);
  box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #ff9940);
}
[data-plugin="keys-palette"] .kp-title { font-size: 14px; font-weight: 600; }
[data-plugin="keys-palette"] .kp-sub {
  font-size: 12px; opacity: .65;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
[data-plugin="keys-palette"] .kp-empty { padding: 18px 16px; font-size: 13px; opacity: .6; }
[data-plugin="keys-palette"] .kp-header {
  padding: 10px 16px 4px; font-size: 11px; font-weight: 700; letter-spacing: .07em;
  color: var(--dsw-alias-label-tertiary, #8a9096); user-select: none;
}
[data-plugin="keys-palette"] .kp-note { padding: 4px 16px 8px; font-size: 12px; opacity: .55; }
[data-plugin="keys-palette"] .kp-slash .kp-title::before {
  content: '/'; color: var(--dsw-alias-brand-primary, #ff9940); font-weight: 700; margin-right: 2px;
}
`

// --- filtering: subsequence match, ranked by keyword hits + recency --------

/** True when every character of `q` appears in `hay` in order. */
function isSubsequence(q: string, hay: string): boolean {
  if (q.length === 0) return true
  let i = 0
  for (const ch of hay) {
    if (ch === q[i]) {
      i += 1
      if (i === q.length) return true
    }
  }
  return false
}

/**
 * undefined = no match. Otherwise the rank score: distinct keyword hits
 * (2 points each) plus 1 when every token appears in the title verbatim.
 * Shared by the command palette and the search mode's client-side corpora.
 */
function fuzzyScore(fields: FuzzyFields, tokens: readonly string[]): number | undefined {
  if (tokens.length === 0) return 0
  const title = fields.title.toLowerCase()
  const subtitle = (fields.subtitle ?? '').toLowerCase()
  const keywords = fields.keywords.map(keyword => keyword.toLowerCase())
  const hay = `${title} ${subtitle} ${keywords.join(' ')}`
  if (!tokens.every(token => isSubsequence(token, hay))) return undefined
  const hits = keywords.filter(keyword =>
    tokens.some(token => keyword.includes(token) || isSubsequence(token, keyword)),
  ).length
  const titleExact = tokens.every(token => title.includes(token))
  return hits * 2 + (titleExact ? 1 : 0)
}

/** Recently-run command ids, best first. Storage failures degrade to "none". */
function recentIds(): string[] {
  try {
    const raw = window.localStorage.getItem(CONFIG.recencyStorageKey)
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, CONFIG.recencyCap)
  } catch {
    return []
  }
}

function noteRun(commandId: string): void {
  try {
    const next = [commandId, ...recentIds().filter(id => id !== commandId)].slice(0, CONFIG.recencyCap)
    window.localStorage.setItem(CONFIG.recencyStorageKey, JSON.stringify(next))
  } catch {
    // recency is best-effort (private mode, quota) — never block the command
  }
}

export const inject = ['layout', 'workspaces', 'uiWorkspace', 'remote.session', 'modelDirectories', 'sessions']

export function apply(ctx: KeysContext): void {
  if (typeof document === 'undefined') return

  // --- DOM -----------------------------------------------------------------
  const style = document.createElement('style')
  style.dataset.plugin = 'keys'
  style.textContent = PALETTE_CSS
  document.head.append(style)

  const root = document.createElement('div')
  root.dataset.plugin = 'keys-palette'
  root.dataset.open = 'false'
  root.innerHTML = `
    <div class="kp-panel">
      <input class="kp-input" type="text" autocomplete="off" spellcheck="false" />
      <div class="kp-list"></div>
    </div>`
  document.body.append(root)

  const input = root.querySelector('.kp-input') as HTMLInputElement
  const list = root.querySelector('.kp-list') as HTMLDivElement

  // --- data sources --------------------------------------------------------
  /** Session list + host-backed message search; every consumer degrades. */
  const sessionsFace = tryGet<SessionsFace>(ctx, 'sessions')

  let open = false
  let mode: PaletteMode = 'commands'
  let filtered: PaletteCommand[] = []
  let searchHits: readonly SearchHit[] = []
  let selected = 0
  let placeholderIndex = 0

  // Message full-text is async and debounced; its state belongs to the
  // currently-displayed query only.
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchAbort: AbortController | undefined
  let messageState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  let messageHits: readonly { sessionId: string; snippet: string }[] = []
  let messageQuery = ''

  function applyPlaceholder(): void {
    input.placeholder = mode === 'search'
      ? 'Search workspaces, sessions, and messages'
      : PLACEHOLDERS[placeholderIndex % PLACEHOLDERS.length] ?? ''
  }
  applyPlaceholder()

  /** Cancel any pending/in-flight message search and drop its results. */
  function resetMessageSearch(): void {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer)
      searchTimer = undefined
    }
    searchAbort?.abort()
    searchAbort = undefined
    messageState = 'idle'
    messageHits = []
    messageQuery = ''
  }

  /** Debounce-query the host message index; delivery is stale-guarded.
   *  The sanctioned `sessions.search` content index is opt-in (disabled in
   *  this fork's base bundle), so a failed/`ok:false` result falls back to
   *  the keys host route's bounded transcript scan (same response shape). */
  function scheduleMessageSearch(query: string): void {
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer)
      searchTimer = undefined
    }
    searchAbort?.abort()
    searchAbort = undefined
    if (query === '') {
      messageState = 'idle'
      messageHits = []
      messageQuery = ''
      return
    }
    const face = sessionsFace
    const deliver = (result: SearchRemoteResult): void => {
      if (result.ok) {
        messageHits = result.value.items
        messageState = 'ready'
      } else {
        messageHits = []
        messageState = 'error'
      }
    }
    const hostFallback = async (signal: AbortSignal): Promise<SearchRemoteResult> => {
      const response = await fetch('/api/keys/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      })
      const parsed: unknown = await response.json()
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return parsed as SearchRemoteResult
      return { ok: false }
    }
    messageState = 'loading'
    messageQuery = query
    searchTimer = setTimeout(() => {
      searchTimer = undefined
      const controller = new AbortController()
      searchAbort = controller
      void (async () => {
        try {
          if (face !== undefined) {
            const result = await face.search(query, controller.signal)
            deliver(result.ok ? result : await hostFallback(controller.signal))
          } else {
            deliver(await hostFallback(controller.signal))
          }
        } catch (error) {
          if (controller.signal.aborted) return
          if (face !== undefined && error instanceof Error && error.name !== 'AbortError') {
            try {
              deliver(await hostFallback(controller.signal))
            } catch {
              if (!controller.signal.aborted) deliver({ ok: false })
            }
          } else {
            deliver({ ok: false })
          }
        }
        if (open && mode === 'search' && input.value.trim() === messageQuery) render()
      })()
    }, CONFIG.searchDebounceMs)
  }

  function passthroughEntry(query: string): PaletteCommand {
    return {
      id: 'passthrough',
      title: query,
      subtitle: 'send to composer',
      keywords: [],
      run: () => {
        composerInsert(query)
      },
    }
  }

  /**
   * Search mode rows for the current query: workspaces and sessions come from
   * the live session list (fuzzy, recency-ordered); messages from the host
   * index. Grouped under muted headers; headers and notes are not selectable.
   */
  function buildSearchRows(query: string, tokens: readonly string[]): SearchRow[] {
    const rows: SearchRow[] = []
    const snapshot = sessionsFace?.list.getSnapshot()
    const rowOf = (id: string): SessionRow | undefined => snapshot?.byId[id]

    // --- workspaces: unique cwd labels, most recent session kept for navigation
    interface WorkspaceBucket {
      label: string
      path: string
      updatedAt: number
      sessionId: string | undefined
    }
    const workspaces = new Map<string, WorkspaceBucket>()
    const sessionCandidates: Array<{ row: SessionRow; title: string; score: number }> = []
    for (const id of snapshot?.ids ?? []) {
      const row = rowOf(id)
      if (row === undefined) continue
      if (row.blank && !row.running) continue
      const label = workspaceLabelOf(row.cwd)
      if (row.cwd !== undefined && label !== undefined) {
        const bucket = workspaces.get(row.cwd)
        if (bucket === undefined) {
          workspaces.set(row.cwd, { label, path: row.cwd, updatedAt: row.updatedAt, sessionId: id })
        } else {
          if (row.updatedAt > bucket.updatedAt) bucket.updatedAt = row.updatedAt
          // keep a non-blank session when the bucket only holds a blank one
          if (!row.blank && (bucket.sessionId === undefined || rowOf(bucket.sessionId)?.blank === true)) {
            bucket.sessionId = id
          }
        }
      }
      const title = row.displayTitle ?? id
      const score = fuzzyScore({ title, keywords: label === undefined ? [] : [label] }, tokens)
      if (score !== undefined) sessionCandidates.push({ row, title, score })
    }

    const workspaceEntries: Array<{ bucket: WorkspaceBucket; score: number }> = []
    for (const bucket of workspaces.values()) {
      const score = fuzzyScore(
        { title: bucket.label, keywords: bucket.path.split('/').filter(part => part !== '') },
        tokens,
      )
      if (score !== undefined) workspaceEntries.push({ bucket, score })
    }
    // keyword hits first; ties go to the most recently active (stable sort)
    workspaceEntries.sort((a, b) =>
      b.score - a.score || b.bucket.updatedAt - a.bucket.updatedAt)
    if (workspaceEntries.length > 0) {
      rows.push({ type: 'header', label: 'workspaces' })
      for (const { bucket } of workspaceEntries.slice(0, CONFIG.searchWorkspaceCap)) {
        const sessionId = bucket.sessionId
        rows.push({
          type: 'hit',
          hit: {
            title: bucket.label,
            subtitle: bucket.path,
            run: () => {
              runWorkspaceHit(ctx, bucket.label, sessionId)
            },
          },
        })
      }
    }

    // --- sessions: titles + last activity, fuzzy + recency
    sessionCandidates.sort((a, b) => b.score - a.score || b.row.updatedAt - a.row.updatedAt)
    const sessionRows = sessionCandidates.slice(0, CONFIG.searchSessionCap)
    if (sessionRows.length > 0) {
      rows.push({ type: 'header', label: 'sessions' })
      for (const { row, title } of sessionRows) {
        const label = workspaceLabelOf(row.cwd)
        rows.push({
          type: 'hit',
          hit: {
            title,
            subtitle: label === undefined
              ? relativeTime(row.updatedAt)
              : `${relativeTime(row.updatedAt)} · ${label}`,
            run: () => {
              openSessionById(ctx, row.id)
            },
          },
        })
      }
    }

    // --- messages: host full-text over transcripts (query required)
    if (query !== '') {
      rows.push({ type: 'header', label: 'messages' })
      if (messageState === 'ready') {
        if (messageHits.length === 0) {
          rows.push({ type: 'note', text: 'no message matches' })
        } else {
          for (const item of messageHits) {
            const row = rowOf(item.sessionId)
            const title = row?.displayTitle ?? `${item.sessionId.slice(0, 10)}…`
            const sessionId = item.sessionId
            rows.push({
              type: 'hit',
              hit: {
                title,
                subtitle: item.snippet,
                run: () => {
                  openSessionById(ctx, sessionId)
                },
              },
            })
          }
        }
      } else if (messageState === 'error') {
        rows.push({ type: 'note', text: 'message search unavailable' })
      } else {
        rows.push({ type: 'note', text: 'searching messages…' })
      }
    }
    return rows
  }

  /** Rows → DOM; only hits join the keyboard/mouse selection. */
  function renderRows(rows: SearchRow[]): void {
    selected = Math.min(selected, Math.max(0, searchHits.length - 1))
    list.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kp-empty'
      empty.textContent = 'No matching workspaces, sessions, or messages.'
      list.append(empty)
      return
    }
    rows.forEach(row => {
      if (row.type === 'header') {
        const header = document.createElement('div')
        header.className = 'kp-header'
        header.textContent = row.label
        list.append(header)
        return
      }
      if (row.type === 'note') {
        const note = document.createElement('div')
        note.className = 'kp-note'
        note.textContent = row.text
        list.append(note)
        return
      }
      const index = searchHits.indexOf(row.hit)
      const item = document.createElement('div')
      item.className = 'kp-item'
      item.dataset.selected = String(index === selected)
      const title = document.createElement('div')
      title.className = 'kp-title'
      title.textContent = row.hit.title
      const sub = document.createElement('div')
      sub.className = 'kp-sub'
      sub.textContent = row.hit.subtitle
      item.append(title, sub)
      item.addEventListener('click', () => {
        void runHit(row.hit)
      })
      item.addEventListener('mousemove', () => {
        if (selected !== index) {
          selected = index
          render()
        }
      })
      list.append(item)
    })
    list.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function renderSearch(): void {
    const query = input.value.trim()
    const tokens = query === '' ? [] : query.toLowerCase().split(/\s+/)
    const hits: SearchHit[] = []
    const rows = buildSearchRows(query, tokens).map((row): SearchRow => {
      if (row.type === 'hit') {
        hits.push(row.hit)
        return { type: 'hit', hit: row.hit }
      }
      return row
    })
    searchHits = hits
    renderRows(rows)
  }

  function renderCommands(): void {
    const query = input.value.trim()
    if (query.startsWith('/') && query.length > 1) {
      filtered = [passthroughEntry(query)]
    } else {
      const tokens = query === '' ? [] : query.toLowerCase().split(/\s+/)
      const recency = new Map(recentIds().map((id, index) => [id, index]))
      const scored: Array<{ command: PaletteCommand; score: number }> = []
      for (const command of COMMANDS) {
        const score = fuzzyScore(command, tokens)
        if (score !== undefined) scored.push({ command, score })
      }
      // keyword hits first; ties go to recently-run commands, then to the
      // COMMANDS order (Array#sort is stable)
      scored.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score
        const ra = recency.get(a.command.id) ?? Number.POSITIVE_INFINITY
        const rb = recency.get(b.command.id) ?? Number.POSITIVE_INFINITY
        return ra - rb
      })
      filtered = scored.map(entry => entry.command)
    }
    searchHits = []
    selected = Math.min(selected, Math.max(0, filtered.length - 1))
    list.innerHTML = ''
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kp-empty'
      empty.textContent = 'No matching command — start with / to pass text to the composer.'
      list.append(empty)
      return
    }
    filtered.forEach((command, i) => {
      const item = document.createElement('div')
      item.className = query.startsWith('/') ? 'kp-item kp-slash' : 'kp-item'
      item.dataset.selected = String(i === selected)
      const title = document.createElement('div')
      title.className = 'kp-title'
      title.textContent = command.title
      const sub = document.createElement('div')
      sub.className = 'kp-sub'
      sub.textContent = command.subtitle ?? ''
      item.append(title, sub)
      item.addEventListener('click', () => {
        void runSelected(command)
      })
      item.addEventListener('mousemove', () => {
        if (selected !== i) {
          selected = i
          render()
        }
      })
      list.append(item)
    })
    list.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }

  function render(): void {
    if (mode === 'search') renderSearch()
    else renderCommands()
  }

  function setOpen(value: boolean, nextMode: PaletteMode = mode): void {
    open = value
    mode = nextMode
    root.dataset.open = String(value)
    resetMessageSearch()
    if (value) {
      input.value = ''
      selected = 0
      if (nextMode === 'commands') placeholderIndex += 1
      applyPlaceholder()
      render()
      input.focus()
      // The composer's editor restores focus on blur and can win the race
      // during the same keydown dispatch; re-assert once it settles.
      requestAnimationFrame(() => {
        if (open && document.activeElement !== input) input.focus()
      })
    }
  }

  async function runSelected(command: PaletteCommand): Promise<void> {
    setOpen(false)
    if (command.id !== 'passthrough') noteRun(command.id)
    await command.run(ctx)
  }

  async function runHit(hit: SearchHit): Promise<void> {
    setOpen(false)
    await hit.run(ctx)
  }

  /** Number of selectable rows under the current mode. */
  function selectableCount(): number {
    return mode === 'search' ? searchHits.length : filtered.length
  }

  input.addEventListener('input', () => {
    selected = 0
    if (mode === 'search') scheduleMessageSearch(input.value.trim())
    render()
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selected = Math.min(selected + 1, Math.max(0, selectableCount() - 1))
      render()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      selected = Math.max(selected - 1, 0)
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (mode === 'search') {
        const hit = searchHits[selected]
        if (hit !== undefined) void runHit(hit)
      } else {
        const command = filtered[selected]
        if (command !== undefined) void runSelected(command)
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
    }
  })
  root.addEventListener('mousedown', event => {
    if (event.target === root) setOpen(false)
  })

  // placeholder rotation runs only while the palette is visible
  const rotateTimer = setInterval(() => {
    if (!open) return
    placeholderIndex += 1
    applyPlaceholder()
  }, CONFIG.placeholderRotateMs)

  // Search results track the live session list (rows arrive after the host
  // answers the first list refresh).
  const unsubscribeSessions = sessionsFace?.list.subscribe(() => {
    if (open && mode === 'search') render()
  })

  // --- global keybinds -----------------------------------------------------
  // Effect contract: the callback sets up, its returned function is the
  // disposer. (The first version removed the DOM inside the setup body —
  // the palette deleted itself the instant it was created.)
  const toggleMode = (target: PaletteMode): void => {
    if (open && mode === target) setOpen(false, target)
    else setOpen(true, target)
  }
  const onKey = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      const key = event.key.toLowerCase()
      // Cmd/Ctrl+<paletteKey> — toggle the palette (no browser-reserved conflict;
      // this intentionally also works while typing in the composer).
      if (key === CONFIG.paletteKey) {
        event.preventDefault()
        event.stopPropagation()
        toggleMode('commands')
        return
      }
      // Cmd/Ctrl+<searchKey> — toggle global search. stopPropagation in the
      // capture phase keeps dsh's native session-search dispatcher (bubble
      // phase, Cmd/Ctrl+K on desktop) from ever seeing the chord; its
      // Cmd/Ctrl+Alt+K web variant carries Alt and still passes through.
      if (key === CONFIG.searchKey) {
        event.preventDefault()
        event.stopPropagation()
        toggleMode('search')
        return
      }
    }
    // Alt+<cyclerKey> — cycle the thinking level for the current session.
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
      && event.key.toLowerCase() === CONFIG.cyclerKey) {
      event.preventDefault()
      event.stopPropagation()
      void cycleThinking(ctx)
    }
  }
  window.addEventListener('keydown', onKey, true)
  ctx.effect(() => () => {
    window.removeEventListener('keydown', onKey, true)
    clearInterval(rotateTimer)
    unsubscribeSessions?.()
    resetMessageSearch()
    root.remove()
    style.remove()
    clearTimeout(toastTimer)
    toastEl?.remove()
    toastEl = undefined
  })
}
