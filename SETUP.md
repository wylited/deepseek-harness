# Local setup (untracked; scoped entirely inside this checkout)

Run dsh from this checkout with `./dsh` (never bare `dsh`, which would use the
global `~/.dsh` home):

```sh
./dsh headless "Reply with exactly: OK"   # one-shot task, final text on stdout
./dsh web --no-open                        # Web UI at http://127.0.0.1:3080
```

**Node requirement** — dsh's profile boot probes Node's module-loader internals
via `node-addon-require-builtin`; its prebuilt darwin-arm64 binding rejects the
code layout of recent Node 24.x builds (24.21.0 nix and 24.22.2 official both
fail with `Unsupported/no-getter`). Node **v24.9.0** is vendored at
`.node/v24.9.0/`, and `./dsh` puts it first on `PATH`. Rebuilds use
`PATH="$PWD/.node/v24.9.0/bin:$PATH" pnpm run build`.

**Local-only scoping** — `./dsh` exports `DSH_HOME=$PWD/.dsh-home` and
`DSH_AGENTS_HOME=$PWD/.dsh-home/agents`; both are bootstrap-only env vars (a
`.env` file cannot set them). Profiles, sessions, `settings.yaml`, logs, and
cache all live under `.dsh-home/`; nothing is written to `~/.dsh` or
`~/.config/dsh`.

**Providers** — `.dsh-home/profiles/headless/cordis.patch.yml` configures the
`llm-pi-ai` plugin with two routes, `zai` (openai-completions, api.z.ai coding
endpoint) and `zcode` (anthropic-messages, zcode.z.ai), each serving
glm-5.3 / glm-5.3-flash / glm-5.3-flashx; `agent-default-model` pins
glm-5.3-flashx via `zai`. The shared API key lives in `.dsh-home/.env` as
`ZAI_API_KEY` and is resolved per request from the env layer — no secret sits
in YAML.

**Web UI** — `./dsh web --no-open` starts the interactive UI on
`http://127.0.0.1:3080` from `.dsh-home/profiles/web/` (same two provider rows
and default model as headless; verified via `--dump-config` to change exactly
those two rows vs the stock web template). The server authenticates every
request: bare `GET /` returns 401; open the tokenized URL printed at startup
(`dsh web: http://127.0.0.1:3080/?token=…`) in a browser, which exchanges the
token for a session cookie.

Two gotchas: the token **rotates on every restart** — an old `?token=…` URL
401s after a relaunch, always take the freshly printed one; and the session
cookie is authority-pinned, so open the exact host printed (`127.0.0.1`, not
`localhost`, unless you also pass `--trusted-host localhost:3080`). Current
long-running invocation (loopback only, both spellings admitted):

```sh
./dsh web --no-open --trusted-host localhost:3080 --trusted-host 192.168.0.54:3080
```

Bind nothing beyond loopback unless you accept the risk: this UI can execute
shell on this machine. For LAN access add `--host 192.168.0.54 --port 3080`
and use the freshly printed tokenized URL.

One-time preparation after a fresh clone: `pnpm install && pnpm run build`
(Typert host bundles and the native runtime are required before any profile
boots).
