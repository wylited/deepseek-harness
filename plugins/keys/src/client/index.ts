/**
 * keys, browser half. Three jobs:
 *
 * 1. Command palette (Cmd/Ctrl+P) — a self-contained modal: the fork's commands,
 *    settings/composer affordances, and free-text slash passthrough into the
 *    composer (native slash autocomplete takes over there). Handrolled because
 *    the ecosystem palette (@dsh-community 0.1.0-alpha.0) imports a settings
 *    API that no longer exists on dsh 0.2.2-rc.1. Filtering is fuzzy
 *    (subsequence match, ranked by keyword hits), the last-executed commands
 *    float to the top, and the modal animates open/closed.
 * 2. Alt+T — cycle the current session's thinking level off→low→high→max.
 * 3. Everything degrades gracefully: every service is optional-injected.
 *
 * All user-tunable values (keybinds, defaults, selectors, timings) live in
 * CONFIG below — see README.md for the full list and how to apply changes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

export const CONFIG = {
  /** Cmd/Ctrl + this key toggles the palette. */
  paletteKey: 'p',
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
[data-plugin="keys-palette"] .kp-sub { font-size: 12px; opacity: .65; }
[data-plugin="keys-palette"] .kp-empty { padding: 18px 16px; font-size: 13px; opacity: .6; }
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
 */
function matchScore(command: PaletteCommand, tokens: readonly string[]): number | undefined {
  if (tokens.length === 0) return 0
  const title = command.title.toLowerCase()
  const subtitle = (command.subtitle ?? '').toLowerCase()
  const keywords = command.keywords.map(keyword => keyword.toLowerCase())
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

export const inject = ['layout', 'workspaces', 'uiWorkspace', 'remote.session', 'modelDirectories']

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

  let open = false
  let filtered: PaletteCommand[] = []
  let selected = 0
  let placeholderIndex = 0

  function applyPlaceholder(): void {
    input.placeholder = PLACEHOLDERS[placeholderIndex % PLACEHOLDERS.length] ?? ''
  }
  applyPlaceholder()

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

  function render(): void {
    const query = input.value.trim()
    if (query.startsWith('/') && query.length > 1) {
      filtered = [passthroughEntry(query)]
    } else {
      const tokens = query === '' ? [] : query.toLowerCase().split(/\s+/)
      const recency = new Map(recentIds().map((id, index) => [id, index]))
      const scored: Array<{ command: PaletteCommand; score: number }> = []
      for (const command of COMMANDS) {
        const score = matchScore(command, tokens)
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
        selected = i
        render()
      })
      list.append(item)
    })
  }

  function setOpen(value: boolean): void {
    open = value
    root.dataset.open = String(value)
    if (value) {
      input.value = ''
      selected = 0
      placeholderIndex += 1
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

  input.addEventListener('input', () => {
    selected = 0
    render()
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selected = Math.min(selected + 1, Math.max(0, filtered.length - 1))
      render()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      selected = Math.max(selected - 1, 0)
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = filtered[selected]
      if (command !== undefined) void runSelected(command)
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

  // --- global keybinds -----------------------------------------------------
  // Effect contract: the callback sets up, its returned function is the
  // disposer. (The first version removed the DOM inside the setup body —
  // the palette deleted itself the instant it was created.)
  const onKey = (event: KeyboardEvent): void => {
    // Cmd/Ctrl+<paletteKey> — toggle the palette (no browser-reserved conflict;
    // this intentionally also works while typing in the composer).
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
      && event.key.toLowerCase() === CONFIG.paletteKey) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(!open)
      return
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
    root.remove()
    style.remove()
    clearTimeout(toastTimer)
    toastEl?.remove()
    toastEl = undefined
  })
}
