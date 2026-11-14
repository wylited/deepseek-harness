# AGENTS.md — dsh fork (`wyli`)

Operating manual for AI agents working in this checkout. This fork runs in two
places; an agent on either machine must be able to redeploy the harness from
this file alone.

## Topology

Two instances of this fork run:

| Instance | Host | Serving | State |
| --- | --- | --- | --- |
| dev (this checkout) | user's Mac | `./dsh web` → http://localhost:3080 | `.dsh-home/` in repo dir |
| prod | warden (NixOS, tailnet-only) | https://ds.ts.wyli.tech | `/var/lib/dsh` |

- Prod: caddy → loopback ports; blue-green slots `dsh@a`/`dsh@b` on 3080/3081
  with health-checked failover; `/var/lib/dsh/.active-slot` names the slot
  that serves. Tokenless inside the tailnet.
- `./dsh` (dev) pins the vendored Node at `.node/v24.9.0` and confines ALL
  state (profile, sessions, settings, logs) to `.dsh-home/`.
- Git: `origin` = upstream deepseek-ai/deepseek-harness — NEVER push there.
  `fork` = github:wylited/deepseek-harness; branch `wyli` is the fork line.
  Plain `git push` goes to `fork/wyli` (pushRemote is preconfigured).
  For changes you are NOT sure about (big refactors, anything touching the
  deployment itself), push `git push origin HEAD:refs/heads/staging`
  instead and tell the user — `wyli` is what warden deploys, and merging
  staging → wyli is the human approval gate.

Prod layout on warden, all under `/var/lib/dsh`:
- `src/` — clone of the fork, branch `wyli` (its default branch). Deploy key
  `/var/lib/dsh/.ssh/id_ed25519` has RW push. Agents may operate here.
- `.built-rev` — last provisioned revision (marker, not source).
- `.active-slot` — which slot serves.
- `home/` — `DSH_HOME`: profile, sessions, ledger. EPHEMERAL STATE, not source.
- `home/profiles/web/cordis.user.yml` — the RUNTIME config layer: an
  agent-writable overlay loaded via `--patch` on every slot boot, composed
  after the store's `cordis.patch.yml`, and NEVER reconciled by provision.
  Instance config (MCP servers, provider routes, plugin tuning) belongs
  here: edit it and dsh hot-reloads — no rebuild, no push, no drain.
  Config model: nix store = infrastructure profile, git fork = capability
  code (`plugins/*`, incl. zero-dep `plugins/caldav-tools`), user.yml =
  instance config.
- `.ssh/` — deploy keys. NEVER leave the machine's context.
- Secrets live OUTSIDE the repo: `/etc/nix/dsh-env` (root-only 0600
  EnvironmentFile: `ZAI_API_KEY`, `PERPLEXITY_JWT`).

## Self-redeploy loop (source-only changes)

1. Edit source, then commit narrowly: `git add <files> && git commit -m "area: what and why"`.
2. `git push` — lands on `fork/wyli`.
3. On warden: `systemctl start dsh-update` (the only admin action polkit
   grants the dsh user).
4. Follow it: `journalctl -u dsh-update -f`. Expect
   `fast-forwarded <old> -> <new>; rebuilding` then `updated; restarting
   dsh.service`. `already at <rev>` = nothing to do. `not a fast-forward …
   refusing` = your history problem; fix upstream, never force.
5. Verify (see below) before claiming anything is deployed.

Mechanics (`nix/module.nix`): dsh-update takes an exclusive flock (one update
at a time), fetches, `merge --ff-only` (refuses otherwise), re-provisions the
app from the new revision, and restarts `dsh.service` only if the clone
actually moved. If the new revision is unhealthy, the old slot keeps serving.

## Heavy path (NixOS module / fleet changes)

Changes to `nix/module.nix`, `nix/package.nix`, `flake.nix`, ports, caddy, or
the slot layout do NOT redeploy via dsh-update. They additionally need the
fleet config repo github:wylited/nix-config (push via key `id_nixconfig`,
host alias `nixconfig.github.com`) and `nixos-rebuild switch` on warden.
This is the heavier, riskier path — flag it before using it.

## Workspaces & self-install

The harness works on itself through a dedicated **`harness-work`** workspace:

- Checkout: `/var/lib/dsh/harness-work` — its own clone on the **`staging`
  branch** (push via deploy key). It is NOT a slot tree: `dsh-update` never
  fast-forwards or rebuilds it, so WIP edits never collide with a flip. It
  runs against the live warden instance for testing.
- Landing work: commit on `staging`, then the user merges `staging → wyli`
  (GitHub) — that merge is the approval gate; the daily `dsh-update` picks
  it up. For quick verification the harness can also run the app from its
  own tree on a spare port.
- Symlink `/var/lib/dsh/home/harness` → `harness-work`. Durable workspace
  id `c877eeb9-aac4-4567-8c0d-34a8ea1e9498` (title `harness-work`), with
  the idle session `harness home`
  (`session-fa26c11d-0131-4005-8171-f4db22cd8f71`).

More workspaces / sessions are created over the same API the web UI uses
(unary RPC POSTed to `/api/<controller>/<method>`; tokenless inside the
tailnet). The envelope wraps the args under a literal `args` key, and the
inner object is keyed by the handler parameter name (`request`):

```sh
rpc() { curl -sS -H 'Host: ds.ts.wyli.tech' -H 'content-type: application/json' \
  -X POST "https://ds.ts.wyli.tech/api/$1" -d "$(printf '{"type":"client-request",\
"rpcId":"%s","method":"%s","payload":{"args":{"request":%s}}}' "$(uuidgen | tr A-Z a-z)" "$1" "$2")"; }

mkdir -p <dir> first — workspace/create REQUIRES an existing directory
rpc workspace/create '{"path":"/var/lib/dsh/harness-work"}'  # idempotent per realpath
rpc session/create   '{"workspaceId":"<id from above>"}'     # binds cwd via the workspace
rpc session/list     '{}'                                    # read-back
```

POST to `/api/...` paths only — the same body posted to `/` 405s. Idle
sessions read back `running:false, blank:true`. Method names per controller
live in `packages/api/*/src/index.ts` (`@Remote('name')`).

Web search: prefer the perplexity-web plugin's tools (session JWT, works
from any IP). The DuckDuckGo backends return EMPTY results from warden's
datacenter IP — upstream anomaly-detection, not a configuration fault;
installing `bun` (already in the dsh nix profile) made the server run, the
results are just bot-walled. A Brave key (BRAVE_API_KEY in
/etc/nix/dsh-env + kind: brave) would restore a dedicated search tool.

Self-software: the dsh user is in `nix.settings.trusted-users` (fleet repo,
`hosts/warden/default.nix`), so the harness can install its own packages:

```sh
sudo -u dsh env HOME=/var/lib/dsh nix profile install nixpkgs#jq
```

Profile lands in `/nix/var/nix/profiles/per-user/dsh` (bin on
`/var/lib/dsh/.nix-profile/bin`). Fleet-level software still goes through
the heavy path above; profile installs are for ad-hoc tooling only.

## Commit hygiene

COMMIT (source and docs only):
- `apps/`, `packages/`, `plugins/` (src + shipped lib), `nix/`, `docs/`,
  `AGENTS.md`.
- `plugins/restyle/lib/` is TRACKED BUILT OUTPUT, intentionally: warden picks
  up plugin-only changes without a Nix rebuild. If you change restyle source,
  rebuild `lib/` and commit both together.
- Other plugins (`keys`, `dashboard`, `perplexity-web`) build during
  provisioning; their `lib/` stays untracked.

NEVER COMMIT:
- SECRETS, before all else. If any diff contains a key, token, or secret:
  STOP, refuse to commit, report it. Rotation-by-removal is the user's call.
- `/var/lib/dsh` contents (runtime state), `.dsh-home/` (local profile +
  sessions + ledger), `work/`, `.node/` (vendored mac Node), `node_modules/`.
- Built outputs that are gitignored (`lib/`, `*.tsbuildinfo`, `dist/`,
  `packages/**/*.js`) — except the intentionally tracked
  `plugins/restyle/lib/`.
- Local-only files: `.env`, `CLAUDE.local.md`.

## Never do

- Never push to `origin` (upstream). The fork line is `fork/wyli` only.
- Never `git reset --hard` on warden; never force-push; never merge non-ff.
- Never edit files under a running generation's `/nix/store` paths; change
  source and redeploy.
- Never copy `/var/lib/dsh/.ssh/` keys or `/etc/nix/dsh-env` off warden.
- Never run overlapping updates; dsh-update's flock serializes — wait for it.
- Never force a failed flip through. If the new revision fails health, the
  old slot keeps serving: report, don't force.
- Never claim "deployed" without Verify evidence.

## Verify before claiming deployed

**UI rule — mobile is not optional.** Every client-side change (pages,
panels, modals, CSS) MUST pass `node scripts/verify-mobile.mjs` (viewports
390×844, 768×1024, 1440×900: no overflow — including the shell-clipped
class, panels attach, palette fits, heatmap bounded, ≥13px fonts, zero
console errors) AND stay desktop-identical at 1440. Follow upstream's
idiom: one `@media (max-width: 767px)` block per stylesheet, dialogs become
full-viewport `100dvh` sheets on mobile, hover styles only under
`@media (hover: hover)`, dense grids scroll in bounded containers, tap
targets ≥44px. Never assume a keyboard or a pointer.


- `curl -sI https://ds.ts.wyli.tech/` returns HTTP 200; the UI's revision
  badge shows your pushed git hash.
- `journalctl -u dsh-update -n 50` shows the fast-forward to your revision.
- `systemctl is-active dsh@a dsh@b` both healthy;
  `cat /var/lib/dsh/.active-slot` names the serving slot; `git -C
  /var/lib/dsh/src rev-parse HEAD` equals your pushed revision.
- On the Mac, `./dsh web` serves :3080 from your checkout as a smoke test.
