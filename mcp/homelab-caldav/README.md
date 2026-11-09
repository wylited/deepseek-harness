# homelab-caldav (MCP stdio server)

Gives dsh agents CalDAV access to the homelab radicale server (events + todos).
Zero dependencies: plain node ≥ 24 runs it directly via native type stripping —
no pnpm workspace membership, no install step. Mount like any custom stdio MCP
server (field shape per `packages/mcp/mcp-manager`; stdio rows take
`command`/`args`/`env`, and env values may use `${credential:…}` templates):

```yaml
- id: caldav-mcp
  kind: custom
  transport: stdio
  command: node
  args: [ '<repo>/mcp/homelab-caldav/src/index.ts' ]
  env:
    RADICALE_URL: https://dav.ts.wyli.tech
    RADICALE_USER: wyli
    RADICALE_PASS: ${credential:…}   # or rely on /etc/nix/dsh-env process env
```

## Config (env only — no secrets in code)

| Key | Meaning |
| --- | --- |
| `RADICALE_URL` | radicale root, e.g. `https://dav.ts.wyli.tech` (caddy vhost on warden, tailnet-only, reverse_proxy → 127.0.0.1:5232) |
| `RADICALE_USER` | radicale principal name (fleet user: `wyli`) |
| `RADICALE_PASS` | any value — radicale has been passwordless since 2026-11-09 (`auth.type = none`, tailnet is the boundary); the principal NAME is the credential |
| `RADICALE_BASIC_USER` / `RADICALE_BASIC_PASS` | optional: only if a front proxy adds its own Basic layer (today caddy adds none — radicale's own htpasswd auth is the only gate) |

For `/etc/nix/dsh-env` (0600, root-owned) append:

```
RADICALE_URL=https://dav.ts.wyli.tech
RADICALE_USER=wyli
RADICALE_PASS=<the radicale password for wyli>
```

Auth mechanism (verified live 2026-11-09): radicale `auth.type = htpasswd`
(`htpasswd_encryption = "md5"` = apr1 hashes in `/etc/nix/radicale-htpasswd`,
root:radicale 0640). Every request carries `Authorization: Basic …`; radicale
re-reads the htpasswd file per request, so credential rotation needs no
restart. Rights are `owner_only`: the principal is `/{RADICALE_USER}/` and the
server only exposes that user's own collections (current-user-principal →
calendar-home-set discovery, no hardcoded paths).

## Tools

- `cal_list_calendars` — names, paths, colors, event/todo support
- `cal_search` — substring query, optional `kind` (event/todo), `collection`, `from`/`to` range, `limit`
- `cal_add_event` — summary, start (all-day `YYYY-MM-DD`, naive local datetime, or ISO with offset/Z), end/durationMin, location, description
- `cal_update_event` — patch by uid (summary/start/end/durationMin/location/description; null clears)
- `cal_delete_event` — delete by uid
- `cal_add_todo` — summary, due?, priority? (1…9), notes? (defaults to the Tasks calendar)
- `cal_todos` — open todos first (then priority, due); `includeCompleted` opt-in
- `cal_complete_todo` — sets STATUS:COMPLETED, COMPLETED:now, PERCENT-COMPLETE:100

Date storage follows wycal's law: ISO input with an offset (incl. `Z`) is
normalized to UTC `…Z`; naive local input stays floating (no `Z`); `YYYY-MM-DD`
is an all-day VALUE=DATE. Updates preserve everything else in the component
(RRULE, CATEGORIES, alarms, X-props) and bump SEQUENCE when present.

Known limitation: pre-existing events that carry an explicit `TZID=` parameter
are surfaced as their wall time (floating form) — search results show the local
time as stored, and `cal_update_event` writes new dates as UTC `Z`/floating, so
a date-field update on such an event drops its TZID (summary/location updates
preserve it). Homelab calendars store almost everything as UTC/all-day; if
TZID-faithful editing ever matters, port wycal's `lib/ics/tz.ts` conversion.

## Smoke test

```sh
RADICALE_URL=… RADICALE_USER=… RADICALE_PASS=… \
  sh -c 'printf "%s\n" \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"0\"}}}" \
  "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" \
  "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" \
  "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"cal_list_calendars\",\"arguments\":{}}}" \
  | node mcp/homelab-caldav/src/index.ts'
```
