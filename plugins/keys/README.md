# keys — palette & keybinds

Browser-half plugin for dsh's web UI. Contributes the command palette
(Cmd/Ctrl+P), the Alt+T thinking-level cycler, and the keybinds behind them.

Handrolled (no external palette dependency): the ecosystem palette
(`@dsh-community/dsh-command-palette` 0.1.0-alpha.0) imports a settings API
that no longer exists on dsh 0.2.2-rc.1, so its activation fails.

## Keybinds

| Bind | Action | Works |
|---|---|---|
| `Cmd+P` / `Ctrl+P` | toggle the palette | anywhere in the web UI, including while the composer is focused |
| `Cmd+K` / `Ctrl+K` | toggle global search (workspaces / sessions / messages) | anywhere; overrides dsh's native `Cmd+K` sidebar search (its `Cmd/Ctrl+Alt+K` web variant still passes through) |
| `Alt+T` | cycle the session's thinking level off → low → high → max | anywhere |
| `↑` / `↓` | move the selection | palette or search open |
| `Enter` | run the selected entry / navigate to the selected result | palette or search open |
| `Esc` | close | palette or search open |
| click on the dimmed backdrop | close | palette or search open |

## Global search (Cmd+K)

The same modal in a second mode. Results are grouped under muted
`workspaces` / `sessions` / `messages` headers; headers are not selectable, so
`↑`/`↓` and `Enter` move and run through hits only. Workspaces and sessions are
matched with the palette's fuzzy subsequence filter, ranked by score then last
activity; messages use plain case-insensitive substring matching.

- **workspaces** — unique workspace labels from the live session list (a cwd's
  basename, or the parent directory when the basename is the bare repo dir —
  same rule `plugins/dashboard` uses). Enter opens the workspace's dashboard
  panel (`layout.selectPanel('workspace-<slug>')`, the shared panel-id
  convention); when no such panel is registered it opens the workspace's most
  recent session instead.
- **sessions** — session titles + relative last activity. Enter opens the
  session via `uiWorkspace.openSession`.
- **messages** — full-text over message transcripts. The client first calls
  the sanctioned `sessions.search` content index; this fork's base bundle
  ships it disabled (`session-query-sqlite` `openAt: never`), and on failure
  the request falls back to this plugin's host route
  (`POST /api/keys/messages`), which scans persisted transcripts through
  `ctx.sessionPersistence` — the 30 most recently written sessions, the last
  800 events of each, matched line ±1 as the snippet, capped at 20 results.
  Enter opens the matching session.

## Commands

| Palette entry | What it does |
|---|---|
| New session · temp workspace | tries a fresh `/tmp/dsh-wyli-…` directory, opens a workspace + session on it, pins `zcode/glm-5.3-flashx`, thinking off. Hosts whose directory picker serves only the `native` capability (no `browse`) reject programmatic `createDirectory` — there the command reuses the shared `/tmp` workspace instead of failing |
| Open dashboard | `layout.selectPanel('dashboard')` |
| Open usage statistics | `layout.selectPanel('usage-stats')` — the panel id registered by `plugins/dashboard` |
| Cycle thinking level | same as Alt+T |
| Open settings | clicks the sidebar settings trigger (host DOM hook) |
| Focus composer | focuses the chat textarea |
| `/text` passthrough | typing `/xyz` (slash + anything) shows a single "send to composer" entry that inserts the raw text (`/xyz `) at the composer caret and focuses it — native slash autocomplete takes over from there |

Filtering is fuzzy: whitespace-separated tokens match as **subsequences**
across title + subtitle + keywords; results are ranked by keyword hits, with
title-substring matches as a tiebreak. The last-executed commands float to the
top of the next open (recent ids in `localStorage`, key `keys.palette.recent`,
capped at 5).

## Why Alt+T on macOS

`Cmd+Tab` is captured by macOS itself (app switcher) before any browser page
sees the event — a web page can never bind it. `Cmd+T` (new tab) and
`Cmd+Shift+T` (reopen tab) are browser-reserved. `Alt+T` (Option+T on macOS)
reaches the page, and the handler `preventDefault()`s so no stray `†` is
typed into the composer. On Linux/Windows Alt+T is equally unclaimed.

## Changing binds & configuration

Everything tunable lives in the `CONFIG` object at the top of
`src/client/index.ts`:

- `paletteKey`, `searchKey`, `cyclerKey` — the key letters for Cmd/Ctrl+`key`
  (palette, search) and Alt+`key` (cycler)
- `searchDebounceMs`, `searchWorkspaceCap`, `searchSessionCap` — search-mode
  tuning: message-query debounce and the two client-side result caps
  (messages are capped host-side at 20)
- `cycleOrder`, `defaultProvider`, `defaultModel`, `seedEffort` — cycler walk
  order and the route pinned on new temp sessions
- `recencyCap`, `recencyStorageKey` — the "recently run floats to top" list
- `animationMs` — palette open/close animation length
- `placeholderRotateMs` — input placeholder rotation interval
- `settingsTriggerSelector`, `composerInputSelector` — DOM hooks into the host
  shell; update these if the shell's structure changes. The composer hook
  lists both spellings (textarea and contenteditable) since the shell has
  used both

Apply a change:

```sh
cd plugins/keys && node build.mjs
```

then reload the web UI — the host serves `lib/client.js` from disk with
content-hash ETags, so no server restart is needed. To load the plugin in a
profile, insert it in the profile's `cordis.patch.yml` (see
`.dsh-home/profiles/scratch-palettekeys/cordis.patch.yml` for a working
example).

## Files

- `src/index.ts` — node half: registers `POST /api/keys/messages`, the
  bounded transcript-scan fallback for message full-text search
- `src/client/index.ts` — everything else: DOM, keybinds, commands, palette
  and search modes, filtering
- `build.mjs` — esbuild bundling to `lib/` in the host's lazy-CJS factory form
  (`window.__ModuleLoader__.load({ id, factory })`, same shape as
  `plugins/restyle`)
