# AGENTS.md — dsh fork (`wyli`)

Operating manual for AI agents working in this checkout. This fork runs in two
places; an agent on either machine must be able to redeploy the harness from
this file alone.

## Topology

Two instances of this fork run:

| Instance | Host | Serving | State |
| --- | --- | --- | --- |
| dev (this checkout) | user's Mac | `./dsh web` → http://localhost:3080 | `.dsh-home/` in repo dir |
| prod | warden (NixOS, tailnet-only) | https://ai.ts.wyli.tech | `/var/lib/dsh` |

- Prod: caddy → loopback ports; blue-green slots `dsh@a`/`dsh@b` on 3080/3081
  with health-checked failover; `/var/lib/dsh/.active-slot` names the slot
  that serves. Tokenless inside the tailnet.
- `./dsh` (dev) pins the vendored Node at `.node/v24.9.0` and confines ALL
  state (profile, sessions, settings, logs) to `.dsh-home/`.
- Git: `origin` = upstream deepseek-ai/deepseek-harness — NEVER push there.
  `fork` = github:wylited/deepseek-harness; branch `wyli` is the fork line.
  Plain `git push` goes to `fork/wyli` (pushRemote is preconfigured).

Prod layout on warden, all under `/var/lib/dsh`:
- `src/` — clone of the fork, branch `wyli` (its default branch). Deploy key
  `/var/lib/dsh/.ssh/id_ed25519` has RW push. Agents may operate here.
- `.built-rev` — last provisioned revision (marker, not source).
- `.active-slot` — which slot serves.
- `home/` — `DSH_HOME`: profile, sessions, ledger. EPHEMERAL STATE, not source.
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

- `curl -sI https://ai.ts.wyli.tech/` returns HTTP 200; the UI's revision
  badge shows your pushed git hash.
- `journalctl -u dsh-update -n 50` shows the fast-forward to your revision.
- `systemctl is-active dsh@a dsh@b` both healthy;
  `cat /var/lib/dsh/.active-slot` names the serving slot; `git -C
  /var/lib/dsh/src rev-parse HEAD` equals your pushed revision.
- On the Mac, `./dsh web` serves :3080 from your checkout as a smoke test.
