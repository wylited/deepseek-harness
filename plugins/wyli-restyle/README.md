# wyli-restyle

Personal web-UI restyle plugin for the wyli fork. Untracked personal state
(the profile mount) lives in `.dsh-home/`; everything in this directory is
tracked and committed, built output included.

## What it does

- **Light only** — pins the theme preference to `light` on apply and re-asserts
  it on every `theme/change` that leaves light, plus a `MutationObserver` on
  the presenter's `body[data-ds-dark-theme]` attribute (a surface that missed
  an event can re-darken the document without a local event). The re-assertion
  is a *delayed* (250 ms) write on purpose: the preference lives in a settings
  document shared by several theme surfaces, and writing immediately races the
  user's transient write — the surface whose write is still in flight folds its
  stale response back over ours. Letting it settle makes this the last writer,
  so the durable value and every echo of it end at light.
- **ayu-light tint** — an `overrideTokens('wyli-restyle/ayu-light', …)` layer
  over the built-in light palette: warm paper `#fafafa`, layers `#f3f4f5`,
  text `#5c6166`, orange accent `#ff9940` (primary/info buttons, links,
  selection, user bubble). Dark values repeat the built-in dark sheet so the
  layer never goes illegible. Token names mirror the light `body` block of
  `packages/client/ui-theme/src/styles/design-platform.css`; none were
  rejected.
- **Straight corners** — the `--dsw-radius-*` scale collapses to 0 plus a
  universal `border-radius: 0 !important` (also squares pills and avatars by
  design). With radius 0 the `corner-shape` superellipse token is inert.
- **Fonts** — self-hosts Atkinson Hyperlegible (regular/bold/italic woff2,
  SIL OFL 1.1) as base64 data URLs; the family is selected by the `ui-theme`
  row's `textFontFamily` in `.dsh-home/profiles/web/cordis.patch.yml`. The
  code font (FiraCode Nerd Font) is a locally installed system font and is
  deliberately not bundled.

## Layout

```
src/index.ts              node half: empty apply (gives Loader a host-side row)
src/client/index.ts       browser half: theme lock + ayu token layer + <style>
src/client/restyle.css    readable stylesheet source (font url placeholders)
assets/fonts/*.woff2      Atkinson Hyperlegible faces, inlined at build time
build.mjs                 build script (see below)
lib/                      built output, committed — no rebuild needed after pull
```

## Build

```
node build.mjs
```

Bundles both halves with esbuild resolved from the enclosing workspace store
(`node_modules/.pnpm`) — the package carries no dependency of its own. The
browser half is emitted in the host's lazy-CJS factory form
(`window.__ModuleLoader__.load({ id, factory })`, matching the repo preset in
`packages/client/tsdown.client.ts`). Fonts become base64 data URLs inside the
bundle, so `lib/` is self-contained and the host never needs the revisioned
`/plugins` asset route.

`lib/` is matched by the repo-root `.gitignore` rule (`lib/`), so committing
rebuilds needs `git add -f plugins/wyli-restyle/lib`. The committed build is
current; no rebuild is needed after a pull.

## Mount (already applied on this machine)

```
./dsh plugin --profile web add "$PWD/plugins/wyli-restyle"
```

plus a row in `.dsh-home/profiles/web/cordis.patch.yml` (untracked):

```yaml
- insert:
    - id: wyli-restyle
      name: wyli-restyle
```

Verify with `./dsh --profile web --dump-config` — the row must be present and
enabled; a failed add exits 0 with empty bundles, so trust the dump.
