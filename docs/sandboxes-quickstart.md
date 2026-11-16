# Sandboxes on this deployment — practical guide

The harness ships a real sandbox subsystem (`docs/subsystems/sandbox.md` is
the authoritative reference; this page is the operator quick-start for the
warden deployment and the local checkout).

## What is sandboxed

**File writes only.** The sandbox confines where the agent's shell (and the
fs tools) may write. Reads, network, and process visibility are deliberately
NOT part of the vocabulary — a sandboxed agent can still read the repo and
call the internet.

## The three modes

| Mode | Writes allowed | Approval on escalation |
|---|---|---|
| `read-only` | nowhere | ask |
| `workspace-write` (the default) | the session's workspace dir + configured extra roots | ask |
| `danger-full-access` | everywhere (provider bypassed) | never |

Escalation is per-call, not sticky: when a write lands outside the fence the
agent can retry with `sandbox_permissions: workspace-write` (or
`danger-full-access`) plus a `justification`; you approve it once in the UI
and the standing mode of the session does not change.

## Per-session switching

- Command palette: `/permission <preset>` — `read-only`, `workspace-write`,
  `danger-full-access` (plus the experimental `auto`). This appends a
  `permission/preset` event to the session, so the choice survives restarts.
- The picker in the settings/status UI does the same thing.
- The model sees the current policy as a `sandbox:policy` context section and
  is told to escalate with a justification instead of flailing.

## Deployment defaults (this fork)

- Default mode: `workspace-write` (`DSH_PERMISSION_MODE` env overrides; the
  fleet module renders the same expression).
- Warden extra writable roots: `/var/lib/dsh/data` — sessions may stage big
  artifacts (dataset drops, archives) there without escalation.
- Linux enforcement order: bubblewrap → Landlock fallback. If neither exists
  the tool FAILS CLOSED (`SANDBOX_UNAVAILABLE`) — it never silently runs
  unconfined. Warden ships bwrap.

## Rules of thumb

1. Leave `workspace-write` on. Escalation prompts are the safety boundary.
2. `danger-full-access` is for throwaway sessions on throwaway trees.
3. Clones that must write outside their workspace (e.g. the harness
   workspace writing to the fleet repo) rely on explicit escalation or on
   the configured extra roots — prefer extra roots over blanket access.
4. If a sandboxed command dies weirdly (bwrap sandbox errors surface as
   non-zero with a `[sandbox: ...]` marker), the fix is usually adding the
   target path as an `additionalWritableRoots` entry in the profile, not
   switching to `danger-full-access`.
