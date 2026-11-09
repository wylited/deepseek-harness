# dsh — NixOS module (branch `wyli`): auto-updating web harness service.
#
# Design: the service does NOT run the nix package. dsh moves constantly, so
# the unit provisions itself from a git clone of the fork inside the state
# directory and a daily timer fast-forwards + rebuilds the branded client
# (fast-forward only — the update never resets or diverges). The Nix closure
# pins the two hard external constraints:
#
#   1. The Node 24.9.0 official linux-x64 tarball. dsh's profile boot probes
#      Node loader internals through node-addon-require-builtin, whose
#      prebuilt binding rejects Node >= 24.10-era codegen (reproduced on
#      24.21/24.22; 24.9.0 works — full story in ../SETUP.md). The tarball is
#      a fetchurl store path: its hash is verified at eval, and the unit
#      extracts it into <stateDir>/node at runtime.
#   2. The profile tree (config-as-code). Every start reconciles
#      <stateDir>/home/profiles/web/ from store copies; hand-edits there are
#      overwritten on the next restart.
#
# Serving is blue-green with per-slot source trees: two concrete instances
# dsh@a / dsh@b (loopback 3080 / 3081, see slotPorts) each serve their OWN
# clone under <stateDir>/src-<slot>; exactly one is active at a time and the
# choice is recorded in <stateDir>/.active-slot (default a, the only
# boot-enabled slot). The canonical path <stateDir>/src is a symlink to the
# tree whose build the shared profile currently resolves (profile link:
# plugins and the in-session harness alias go through it), repointed only at
# a verified flip or a watchdog rollback — the ACTIVE slot's tree is never
# touched by an update. The update unit fast-forwards + rebuilds only the
# IDLE tree, records the serving build's rev in .last-good-rev, drains the
# active slot (polls POST /api/session/list until no session reports
# running, 15 min budget — timeout aborts with the old slot still serving),
# then flips: start the new slot, wait for 200, stop the old, re-verify the
# new slot 3x over ~5s (any failure restarts the old slot and restores
# .active-slot). A 60s dsh-watchdog timer covers the crash case: 3
# consecutive failed health checks of the active slot stop it and promote
# the other slot — whose tree provably still holds the last-known-good
# build — restoring service ≤3 min after the failure began. Caddy fronts
# BOTH ports with active health checks (fleet ingress module), so the flip
# itself never drops the vhost.
#
# Keys: providers resolve apiKeyEnv (ZAI_API_KEY) from the process
# environment, so /etc/nix/dsh-env (EnvironmentFile, optional) supplies them:
#
#   # /etc/nix/dsh-env  (root:root 0600)
#   ZAI_API_KEY=...                 # zai + zcode rows both read this
#   ZCODE_API_KEY=...               # reserved (profile rows currently map
#                                   # zcode to ZAI_API_KEY as on the mac)
#   PERPLEXITY_SESSION_TOKEN=...    # perplexity-web plugin
#
# The service starts fine without the file (degraded providers).
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.dsh;

  repoUrl = "https://github.com/wylited/deepseek-harness";
  branch = "wyli";
  clientVersion = "0.2.2-rc.1";

  nodeVersion = "24.9.0";
  nodeTarball = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz";
    hash = "sha256-9S7FDpWdctXGgNlzFCCyZhzSqAcOlMc2m23fzYtyeL4=";
  };

  # Canonical source path: a symlink to the tree whose build the shared
  # profile (link: plugin deps, homelab-caldav MCP args, home/harness alias)
  # resolves through. Repointed only at a verified flip (updater) or a
  # rollback (watchdog); the active slot's own tree is never rewritten.
  src = "${cfg.stateDir}/src";
  # Per-slot source tree + built marker: src-a is served by dsh@a, src-b by
  # dsh@b; an update rebuilds ONLY the idle tree.
  slotTree = slot: "${cfg.stateDir}/src-${slot}";
  slotBuiltMarker = slot: "${cfg.stateDir}/.built-rev-${slot}";
  nodeDir = "${cfg.stateDir}/node";
  home = "${cfg.stateDir}/home";
  lockFile = "${cfg.stateDir}/.lock";
  activeSlotFile = "${cfg.stateDir}/.active-slot";
  # Rollback bookkeeping: .last-good-rev names the rev of the build that is
  # CURRENTLY SERVING (written by the updater before it rebuilds the idle
  # tree); .rolled-back marks a completed watchdog rollback; .watchdog-fails
  # counts consecutive failed health checks; .watchdog-dead latches
  # both-slots-down so the watchdog never thrashes.
  lastGoodRevFile = "${cfg.stateDir}/.last-good-rev";
  rolledBackFile = "${cfg.stateDir}/.rolled-back";
  watchdogFailsFile = "${cfg.stateDir}/.watchdog-fails";
  # Rollback episodes without an intervening healthy tick; two in a row
  # means both slots are broken — the watchdog latches instead of trying
  # again (it must never thrash between two dead slots).
  watchdogRollsFile = "${cfg.stateDir}/.watchdog-rolls";
  watchdogDeadFile = "${cfg.stateDir}/.watchdog-dead";
  corepackHome = "${cfg.stateDir}/corepack";
  bind = "127.0.0.1";

  # Blue-green slot map: instance name → loopback port. Slot a is the boot
  # slot (multi-user.target); the update wrapper flips a↔b around rebuilds.
  slotPorts = {
    a = cfg.port;
    b = cfg.port + 1;
  };

  # Non-interactive git over the RW deploy key: used by updateInner's fetch,
  # provision-time operations, and any in-session harness git (push/fetch)
  # spawned by the service. known_hosts is pre-seeded at provision time.
  sshCommand = "ssh -i ${cfg.stateDir}/.ssh/id_ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=${cfg.stateDir}/.ssh/known_hosts -o StrictHostKeyChecking=accept-new";

  # Toolchain for the runtime builds: pnpm install compiles node-pty
  # (node-gyp needs python3 + make + a C++ compiler); git fetches the clone;
  # patchelf rewrites the official node binary for NixOS (see provision).
  toolPath = lib.makeBinPath [
    pkgs.git
    pkgs.gcc
    pkgs.gnumake
    pkgs.python3
    pkgs.xz
    pkgs.gnutar
    pkgs.coreutils
    pkgs.gnugrep
    pkgs.gnused
    pkgs.bash
    pkgs.util-linux
    pkgs.patchelf
  ];

  # NixOS maps /lib64/ld-linux-x86-64.so.2 to a stub that refuses generic
  # dynamically-linked binaries (verified on warden), so the vendored official
  # node gets the nixpkgs interpreter + a libstdc++/libgcc_s rpath at
  # extraction time. dlopen'd native prebuilts (koffi) resolve libstdc++
  # through LD_LIBRARY_PATH, set on the service below.
  gccLib = "${pkgs.stdenv.cc.cc.lib}/lib";
  dynamicLinker = pkgs.stdenv.cc.bintools.dynamicLinker;

  # ---- profile tree (mirrors the mac checkout's .dsh-home/profiles/web) ----

  profileWorkspace = pkgs.writeText "dsh-profile-pnpm-workspace.yaml" ''
    packages:
      - .

    nodeLinker: hoisted
    autoInstallPeers: false
  '';

  profileCordisYml = pkgs.writeText "dsh-profile-cordis.yml" ''
    # dsh profile root — an empty entry list. The tree is composed as patches:
    # each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml,
    # then any --patch overlays. Edit cordis.patch.yml, not this file.
    []
  '';

  profilePackageJson = pkgs.writeText "dsh-profile-package.json" (
    builtins.toJSON {
      name = "dsh-profile-web";
      private = true;
      packageManager = "pnpm@11.28.5";
      dsh.profile.bundles = [
        "@deepseek-ai/dsh-base"
        "@deepseek-ai/dsh-web-app"
        "@deepseek-ai/dsh-experimental-voice-input-bundle"
        "perplexity-web"
        "@letter2025/dsh-search-mcp"
      ];
      dependencies = {
        "@letter2025/dsh-search-mcp" = "^0.3.4";
        dashboard = "link:${src}/plugins/dashboard";
        keys = "link:${src}/plugins/keys";
        perplexity-web = "link:${src}/plugins/perplexity-web";
        restyle = "link:${src}/plugins/restyle";
      };
    }
  );

  # Patch tree for the web profile, ported from the fork maintainer's local
  # .dsh-home/profiles/web/cordis.patch.yml (raw-model measurement setup) with
  # two warden adaptations already applied:
  #   - connection row: tokenless admission inside the tailnet — authMode
  #     trust-network + trustedHosts restated (patch rows REPLACE the whole
  #     config; a bare host entry matches any port).
  #   - agent default model zcode/glm-5.3-flashx, same as the mac.
  # Provider keys are NOT here: apiKeyEnv rows resolve from the process
  # environment (EnvironmentFile /etc/nix/dsh-env).
  profilePatch = pkgs.writeText "dsh-profile-cordis.patch.yml" ''
    # Fleet profile for warden (generated by nix/module.nix — edits here are
    # reconciled back to the store copy on the next service start). Patches
    # address base-bundle rows by id and REPLACE each targeted row's complete
    # config value.

    # Provider routes for the pi-ai multi-provider adapter. Keys resolve per
    # request from the process environment (EnvironmentFile); no secret lives
    # in this file.
    - id: llm-pi-ai
      config:
        providers:
          zai:
            displayName: Z.ai
            apiKeyEnv: ZAI_API_KEY
            api: openai-completions
            baseURL: https://api.z.ai/api/coding/paas/v4
            # Standard OpenAI request shape: system role, max_tokens cap. dsh's
            # provider guide starts unknown OpenAI-compatible gateways here.
            compat:
              supportsDeveloperRole: false
              maxTokensField: max_tokens
            # Reasoning efforts per model. The zai gateway takes thinkingFormat:
            # zai — inherited from the installed catalog for glm-5.3 and
            # glm-5.3-flash, restated on glm-5.3-flashx (absent from the catalog,
            # so it also declares the siblings' compat; zaiToolStream stays
            # catalog-withheld). "off" sends thinking {type: disabled}; every
            # thinking level sends reasoning_effort <spelling>. Both shapes
            # verified live against api.z.ai (200).
            models:
              - id: glm-5.3
                name: GLM-5.3
                contextWindow: 1000000
                maxTokens: 131072
                input: [ text ]
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max
              - id: glm-5.3-flash
                name: GLM-5.3 Flash
                contextWindow: 1000000
                maxTokens: 131072
                input: [ text, image ]
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max
              - id: glm-5.3-flashx
                name: GLM-5.3 FlashX
                contextWindow: 1000000
                maxTokens: 131072
                input: [ text, image ]
                compat:
                  supportsStore: false
                  supportsReasoningEffort: true
                  thinkingFormat: zai
                  supportsStrictMode: true
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max
          zcode:
            displayName: ZCode
            apiKeyEnv: ZAI_API_KEY
            api: anthropic-messages
            baseURL: https://zcode.z.ai/api/v1/ultra-zai/anthropic
            # Anthropic surface: "off" sends thinking {type: disabled} (verified
            # live against zcode.z.ai, 200); low/high/max ride the extended-
            # thinking budget path (2048/16384/16384 tokens — pi-ai clamps max to
            # high unless profile thinkingBudgets say otherwise), and the
            # spellings double as adaptive-effort names should
            # forceAdaptiveThinking ever be set.
            models:
              - id: glm-5.3
                name: GLM-5.3 (ZCode)
                contextWindow: 1000000
                maxTokens: 128000
                input: [ text ]
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max
              - id: glm-5.3-flash
                name: GLM-5.3 Flash (ZCode)
                contextWindow: 204800
                maxTokens: 131072
                input: [ text, image ]
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max
              - id: glm-5.3-flashx
                name: GLM-5.3 FlashX (ZCode)
                contextWindow: 1000000
                maxTokens: 131072
                input: [ text, image ]
                reasoningEfforts:
                  off:
                  low: low
                  high: high
                  max: max

    # Default route for new agents: glm-5.3-flashx via zcode. dsh has no
    # cross-provider fallback (recon-verified) — same-provider retry only, via
    # llm-retry; a zcode outage is never silently rerouted to zai.
    - id: agent-default-model
      config:
        provider: zcode
        model: glm-5.3-flashx

    # Auto-compaction: summarize + truncate at ~30% context pressure.
    # thresholdRatio is the knob (0.2 compacts early, 0.5 late); the verbatim
    # tail keeps the default 16% (retainRatio, must stay below thresholdRatio).
    # Per-model overrides go under modelPolicies.
    - id: compaction-basic
      disabled: false
      config:
        auto: true
        thresholdRatio: 0.3
    - id: ui-settings-general
      name: "@deepseek-ai/dsh-client-ui-settings-general"
      config:
        welcomeNoticeVersion: 2026-09-28.1
    - id: ui-theme
      name: "@deepseek-ai/dsh-client-ui-theme"
      config:
        preference: light
        textFontFamily: '"Atkinson Hyperlegible", "Atkinson Hyperlegible Next"'
        codeFontFamily: '"FiraCode Nerd Font", "FiraCode NFP", ui-monospace, Menlo, monospace'
    - id: session-log-deepseek
      name: "@deepseek-ai/dsh-session-log-deepseek"
      config:
        enabled: false

    # Personal web-UI restyle: ayu-light tint, Atkinson Hyperlegible hosting,
    # straight corners, light-only theme lock.
    - insert:
        - id: restyle
          name: restyle
    - insert:
        - id: perplexity-web
          name: perplexity-web
    - insert:
        - id: dashboard
          name: dashboard
    - insert:
        - id: keys
          name: keys
    - id: search-mcp
      config:
        defaultServer: ddg-html
        maxResults: 8
        searchTimeoutMs: 30000
        servers:
          - id: ddg-html
            kind: custom
            transport: stdio
            command: npx
            args: [ '-y', 'duckduckgo-mcp' ]
            toolName: search
            maxResults: 8
          # Homelab CalDAV (radicale, dav.ts.wyli.tech): search/add/update
          # events + todos. Zero-dep stdio MCP server shipped in the fork;
          # credentials from the service env (/etc/nix/dsh-env:
          # RADICALE_URL / RADICALE_USER / RADICALE_PASS).
          - id: homelab-caldav
            kind: custom
            transport: stdio
            command: node
            args: [ '${src}/mcp/homelab-caldav/src/index.ts' ]

    # Tokenless admission on the trusted tailnet: any request passing the
    # Host/Origin fence (loopback, the listener's bind IP, or this list) is
    # admitted without the browser cookie; an untrusted Host still gets 403.
    # Patch rows REPLACE the row's complete config, so trustedHosts is restated
    # here instead of relying on the bundle's webStartup expression.
    - id: connection
      config:
        authMode: trust-network
        trustedHosts:
${lib.concatStringsSep "\n" (map (h: "          - ${h}") cfg.trustedHosts)}
          # Port-less entry matches any port; both blue-green slots (and the
          # localhost:port web UI) pass. Bare 127.0.0.1 needs no entry: the
          # fence always admits the listener's loopback bind literal.
          - localhost
  '';

  profileStore = pkgs.runCommand "dsh-profile-web" { } ''
    mkdir -p $out
    install -m 444 ${profileCordisYml} $out/cordis.yml
    install -m 444 ${profilePatch} $out/cordis.patch.yml
    install -m 444 ${profilePackageJson} $out/package.json
    install -m 444 ${profileWorkspace} $out/pnpm-workspace.yaml
  '';

  # Per-slot provisioning is idempotent and run as the dsh user under the
  # state flock (callers: both dsh@a/dsh@b ExecStartPre and the update unit,
  # so concurrent provisions serialize). The built-marker gate is PER SLOT:
  # a slot whose tree already matches its .built-rev-<slot> no-ops here.
  # One-time state-layout migration (idempotent, run as the dsh user): the
  # single-tree layout kept one real clone at <stateDir>/src with a global
  # .built-rev. Move it into slot a's tree (clone history and built marker
  # preserved — no forced rebuild), then install the canonical src symlink.
  layoutMigrate = pkgs.writeShellScript "dsh-layout-migrate" ''
    set -euo pipefail
    stateDir=${cfg.stateDir}
    if [ -d "$stateDir/src" ] && [ ! -L "$stateDir/src" ] && [ ! -d "$stateDir/src-a" ]; then
      ${pkgs.coreutils}/bin/mv "$stateDir/src" "$stateDir/src-a"
      if [ -f "$stateDir/.built-rev" ]; then
        ${pkgs.coreutils}/bin/mv "$stateDir/.built-rev" "$stateDir/.built-rev-a"
      fi
      ${pkgs.coreutils}/bin/ln -s "$stateDir/src-a" "$stateDir/.src.tmp.$$"
      ${pkgs.coreutils}/bin/mv -T "$stateDir/.src.tmp.$$" "$stateDir/src"
      echo "dsh-provision: migrated single-tree layout to src-a + canonical src symlink"
    fi
  '';

  # Idempotent per-slot provisioning, run as the dsh user under the state
  # lock; the slot arrives as $1. Clones the slot's OWN tree if missing,
  # reconciles the shared profile + vendored node, then builds the branded
  # client INSIDE that slot's tree and stamps .built-rev-<slot>. Callers:
  # dsh@%i ExecStartPre (slot %i) and the update unit (idle slot). The
  # ACTIVE slot's tree is only read here (marker check), never written.
  provisionScript = pkgs.writeShellScript "dsh-provision" ''
    set -euo pipefail
    slot="''${1:-}"
    if [ "$slot" != "a" ] && [ "$slot" != "b" ]; then
      echo "dsh-provision: slot argument required (a|b), got '$slot'" >&2
      exit 1
    fi
    ${layoutMigrate}
    stateDir=${cfg.stateDir}
    src="$stateDir/src-$slot"
    builtMarker="$stateDir/.built-rev-$slot"
    nodeDir=${nodeDir}
    profileDir=${home}/profiles/web

    mkdir -p ${corepackHome} ${home} "$profileDir"

    # --- per-slot source clone ----------------------------------------------
    # A clone interrupted mid-flight leaves a .git with no HEAD; treat any
    # clone whose HEAD cannot resolve as missing and start over.
    if ! ${pkgs.git}/bin/git -C "$src" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      ${pkgs.coreutils}/bin/rm -rf "$src"
      ${pkgs.git}/bin/git clone --branch ${branch} --single-branch ${repoUrl} "$src"
    fi

    # --- ssh host trust for github.com --------------------------------------
    # The clone's origin is SSH (RW deploy key) and the in-session harness
    # pushes through GIT_SSH_COMMAND; pre-seed the host key so the first
    # unattended fetch never stalls on a host-key prompt.
    sshDir=${cfg.stateDir}/.ssh
    mkdir -p "$sshDir"
    touch "$sshDir/known_hosts"
    if ! ${pkgs.gnugrep}/bin/grep -qs '^github.com ' "$sshDir/known_hosts"; then
      ${pkgs.openssh}/bin/ssh-keyscan -t ed25519,rsa github.com >> "$sshDir/known_hosts" 2>/dev/null || true
    fi

    # --- vendored node ------------------------------------------------------
    if [ "$(${pkgs.coreutils}/bin/cat "$nodeDir/.dsh-version" 2>/dev/null || true)" != "${nodeVersion}" ]; then
      ${pkgs.coreutils}/bin/rm -rf "$nodeDir"
      ${pkgs.coreutils}/bin/mkdir -p "$nodeDir"
      ${pkgs.gnutar}/bin/tar -xJf ${nodeTarball} -C "$nodeDir" --strip-components=1
      echo ${nodeVersion} > "$nodeDir/.dsh-version"
      ${pkgs.patchelf}/bin/patchelf \
        --set-interpreter ${dynamicLinker} \
        --set-rpath ${gccLib} \
        "$nodeDir/bin/node"
    fi

    # --- profile tree (store copy is authoritative) -------------------------
    dirty=0
    for name in cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml; do
      if ! ${pkgs.diffutils}/bin/cmp -s "${profileStore}/$name" "$profileDir/$name"; then
        ${pkgs.coreutils}/bin/install -m 600 "${profileStore}/$name" "$profileDir/$name"
        dirty=1
      fi
    done

    # --- harness workspace alias ---------------------------------------------
    # Profiles cannot declare named workspaces (workspaces are runtime UI
    # records created via workspace.create — recon 2026-11-09). Convention:
    # ${home}/harness is a stable alias for the fork checkout the harness
    # redeploys from — no git worktree, no second clone. It targets the
    # canonical src symlink, so it always resolves into the ACTIVE slot's
    # tree, across flips and watchdog rollbacks alike.
    ln -sfn ${src} ${home}/harness

    # Profile deps: one registry package + link: plugins into the clone.
    if [ "$dirty" -eq 1 ] || [ ! -d "$profileDir/node_modules" ]; then
      (cd "$profileDir" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=${corepackHome} ${nodeDir}/bin/corepack pnpm install)
    fi

    # --- repo deps + branded client build (first boot + after each update) --
    head_rev=$(${pkgs.git}/bin/git -C "$src" rev-parse HEAD)
    built_rev=$(${pkgs.coreutils}/bin/cat "$builtMarker" 2>/dev/null || true)
    if [ "$head_rev" != "$built_rev" ] || [ ! -d "$src/node_modules" ]; then
      (
        cd "$src"
        # Exported for BOTH commands: `VAR=.. cmd1 && cmd2` binds the prefixes
        # to cmd1 only — the bare build then derives the client hash from git
        # (observed: sidebar badge rendered the commit hash instead of 'wyli').
        export DSH_BUILD_CLIENT_PROFILE=local
        export DSH_CLIENT_VERSION=${clientVersion}
        export DSH_CLIENT_COMMIT_HASH=wyli
        export DSH_CLIENT_GIT_DIRTY=false
        export DSH_TELEMETRY_DISABLED=1
        export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=${corepackHome}
        ${nodeDir}/bin/corepack pnpm install --frozen-lockfile &&
          ${nodeDir}/bin/corepack pnpm run build
      )
      # The profile's link: plugins ship lib/ as a gitignored build output —
      # a fresh clone has none, and the web profile fails their import
      # (ERR_MODULE_NOT_FOUND) at boot without it.
      for p in dashboard keys restyle; do
        DSH_TELEMETRY_DISABLED=1 ${nodeDir}/bin/node "$src/plugins/$p/build.mjs"
      done
      perplexity=$src/plugins/perplexity-web
      ${pkgs.coreutils}/bin/mkdir -p "$perplexity/node_modules/@deepseek-ai"
      ${pkgs.coreutils}/bin/ln -sfn ../../../../vendor/cordis "$perplexity/node_modules/@deepseek-ai/cordis"
      ${pkgs.coreutils}/bin/ln -sfn ../../../../vendor/schemastery "$perplexity/node_modules/@deepseek-ai/schemastery"
      ${pkgs.coreutils}/bin/ln -sfn ../../../../packages/web/web "$perplexity/node_modules/@deepseek-ai/dsh-web"
      (cd "$perplexity" && "$src/node_modules/.bin/tsc" -p tsconfig.json)
      echo "$head_rev" > "$builtMarker.tmp"
      ${pkgs.coreutils}/bin/mv "$builtMarker.tmp" "$builtMarker"
    fi
  '';

  # Update decision + idle-tree build, run AS the dsh user (inside setpriv)
  # under the state lock. Resolves the active slot, fast-forwards ONLY the
  # idle tree to origin/wyli, records the currently-serving build's rev in
  # .last-good-rev (rollback point), then provisions the idle tree. Exit 42
  # = a flip is needed; the root wrapper then drains + flips. Never resets
  # or force-updates; the ACTIVE slot's tree is never written here.
  updateInner = pkgs.writeShellScript "dsh-update-inner" ''
    set -euo pipefail
    exec 9>>${lockFile}
    ${pkgs.util-linux}/bin/flock -x 9
    ${layoutMigrate}

    active=$(${pkgs.coreutils}/bin/cat ${activeSlotFile} 2>/dev/null || true)
    if [ "$active" != "b" ]; then active=a; fi
    if [ "$active" = "a" ]; then idle=b; else idle=a; fi
    idleTree=${cfg.stateDir}/src-$idle

    if ! ${pkgs.git}/bin/git -C ${cfg.stateDir}/src-a rev-parse --verify -q HEAD >/dev/null 2>&1; then
      echo "dsh-update: no usable slot-a clone yet; dsh@a owns first provisioning"
      exit 0
    fi
    if ! ${pkgs.git}/bin/git -C "$idleTree" rev-parse --verify -q HEAD >/dev/null 2>&1; then
      echo "dsh-update: (re)cloning idle tree src-$idle"
      ${pkgs.coreutils}/bin/rm -rf "$idleTree"
      ${pkgs.git}/bin/git clone --branch ${branch} --single-branch ${repoUrl} "$idleTree"
    fi

    old=$(${pkgs.git}/bin/git -C "$idleTree" rev-parse HEAD)
    ${pkgs.git}/bin/git -C "$idleTree" fetch origin ${branch}
    if ! ${pkgs.git}/bin/git -C "$idleTree" merge --ff-only origin/${branch}; then
      echo "dsh-update: origin/${branch} is not a fast-forward from src-$idle HEAD; refusing" >&2
      exit 1
    fi
    new=$(${pkgs.git}/bin/git -C "$idleTree" rev-parse HEAD)

    activeHead=$(${pkgs.git}/bin/git -C ${cfg.stateDir}/src-$active rev-parse HEAD)
    activeBuilt=$(${pkgs.coreutils}/bin/cat ${cfg.stateDir}/.built-rev-$active 2>/dev/null || true)
    idleBuilt=$(${pkgs.coreutils}/bin/cat ${cfg.stateDir}/.built-rev-$idle 2>/dev/null || true)
    if [ "$activeHead" = "$new" ] && [ "$activeBuilt" = "$new" ] && [ "$idleBuilt" = "$new" ]; then
      echo "dsh-update: already at $new"
      exit 0
    fi
    if [ "$old" != "$new" ]; then
      echo "dsh-update: fast-forwarded src-$idle $old -> $new; rebuilding"
    else
      echo "dsh-update: src-$idle build stale (head $new, built ''${idleBuilt:-none}); rebuilding"
    fi

    # Rollback point: the rev of the build CURRENTLY SERVING (active tree
    # HEAD), written before anything moves. The watchdog only rolls back to
    # a tree whose built marker matches this file.
    printf '%s' "$activeHead" > ${lastGoodRevFile}.tmp
    ${pkgs.coreutils}/bin/mv ${lastGoodRevFile}.tmp ${lastGoodRevFile}

    ${provisionScript} "$idle"
    exit 42
  '';

  # Root wrapper: drop to the dsh uid for everything touching stateDir; on a
  # successful idle-tree build (exit 42) run the flip: drain the active slot
  # first (no running agent is ever retired), repoint the canonical src
  # symlink at the new tree, boot + health the new slot, retire the old, then
  # re-verify the new slot 3x over ~5s. A drain timeout or a failed
  # verification leaves (or restores) the old slot serving and exits
  # non-zero; the flip itself never drops the vhost (caddy health-checks
  # both upstreams).
  updateScript = pkgs.writeShellScript "dsh-update" ''
    set -euo pipefail
    set +e
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.coreutils}/bin/env HOME=${home} COREPACK_HOME=${corepackHome} COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      LD_LIBRARY_PATH=${gccLib} \
      GIT_SSH_COMMAND=${lib.escapeShellArg sshCommand} \
      PATH=${home}/.nix-profile/bin:${nodeDir}/bin:${toolPath}:/run/current-system/sw/bin \
      ${updateInner}
    rc=$?
    set -e
    if [ "$rc" -ne 42 ]; then
      [ "$rc" -eq 0 ] || exit "$rc"
      exit 0
    fi
    # Read the slot AS the dsh user: the unit's bounding set strips
    # CAP_DAC_OVERRIDE and /var/lib/dsh is 0700 dsh-owned — root cannot
    # even traverse it (observed 2026-11-09: empty read misdetected the
    # active slot and no-op'd the flip).
    active=$(${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.coreutils}/bin/cat ${activeSlotFile} 2>/dev/null || true)
    if [ "$active" != "b" ]; then active=a; fi
    if [ "$active" = "a" ]; then idle=b; else idle=a; fi
    activePort=${toString slotPorts.a}
    idlePort=${toString slotPorts.b}
    if [ "$active" = "b" ]; then
      activePort=${toString slotPorts.b}
      idlePort=${toString slotPorts.a}
    fi
    activeTree=${cfg.stateDir}/src-$active
    idleTree=${cfg.stateDir}/src-$idle
    # All state mutations below go through setpriv (dsh uid) for the same
    # reason: the unit's bounding set strips CAP_DAC_OVERRIDE.

    # --- drain-before-flip -----------------------------------------------------
    # Poll the active slot's session list until no session reports running
    # (POST /api/session/list; SessionSummary.running, recon 2026-11-09).
    # Budget: 15 minutes. On timeout ABORT: the old slot keeps serving, the
    # rebuilt new slot is brought up idle, and the next run finds both trees
    # ready — an agent finishing a 2h task is never killed by an update.
    deadline=$(( $(${pkgs.coreutils}/bin/date +%s) + 900 ))
    lastLog=0
    while :; do
      resp=$(${pkgs.curl}/bin/curl -fsS --max-time 5 -X POST "http://127.0.0.1:$activePort/api/session/list" \
        -H 'content-type: application/json' \
        -d '{"type":"client-request","rpcId":"dsh-update-drain","method":"session/list","payload":{"args":{"_request":{}}}}' 2>/dev/null || true)
      if printf '%s' "$resp" | ${pkgs.gnugrep}/bin/grep -q '"ok":true'; then
        running=$(printf '%s' "$resp" | ${pkgs.gnugrep}/bin/grep -o '"running":true' | ${pkgs.coreutils}/bin/wc -l || true)
        if [ "$running" -eq 0 ]; then
          echo "dsh-update: drain complete; no running agents on dsh@$active"
          break
        fi
        now=$(${pkgs.coreutils}/bin/date +%s)
        if [ $((now - lastLog)) -ge 30 ]; then
          echo "dsh-update: drain: $running agent(s) still running on dsh@$active"
          lastLog=$now
        fi
      else
        # Sessions API unreachable: if the slot's health is gone too, the
        # process is dead — no live agent can survive on it, so draining is
        # satisfied and the flip doubles as crash recovery.
        code=$(${pkgs.curl}/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$activePort/" || true)
        if [ "$code" != "200" ]; then
          echo "dsh-update: dsh@$active is down during drain; no live process to drain — proceeding with flip" >&2
          break
        fi
      fi
      if [ "$(${pkgs.coreutils}/bin/date +%s)" -ge "$deadline" ]; then
        echo "dsh-update: drain timeout (15m) with agents still running; ABORTING flip; dsh@$active keeps serving" >&2
        systemctl start "dsh@$idle"
        exit 1
      fi
      sleep 10
    done

    # --- flip -------------------------------------------------------------------
    # Repoint the canonical src symlink at the new tree BEFORE the new slot
    # boots, so its profile link: plugins resolve into src-<idle>. The old
    # slot holds its plugins in memory and is about to be retired anyway.
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.bash}/bin/sh -c "ln -sfn '$idleTree' '${cfg.stateDir}/.src.tmp' && mv -T '${cfg.stateDir}/.src.tmp' '${src}'"
    echo "dsh-update: src -> src-$idle; bringing up dsh@$idle on 127.0.0.1:$idlePort"
    # restart (not start): a previous drain timeout may have left it running.
    systemctl restart "dsh@$idle"

    ok=
    waited=0
    while [ "$waited" -lt 180 ]; do
      code=$(${pkgs.curl}/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$idlePort/" || true)
      if [ "$code" = "200" ]; then ok=1; break; fi
      sleep 2
      waited=$((waited + 2))
    done
    if [ -z "$ok" ]; then
      echo "dsh-update: dsh@$idle never served 200 on 127.0.0.1:$idlePort within 180s; keeping dsh@$active" >&2
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.bash}/bin/sh -c "ln -sfn '$activeTree' '${cfg.stateDir}/.src.tmp' && mv -T '${cfg.stateDir}/.src.tmp' '${src}'"
      systemctl stop "dsh@$idle"
      exit 1
    fi

    echo "dsh-update: dsh@$idle healthy; retiring dsh@$active"
    systemctl stop "dsh@$active"

    # --- flip verification -------------------------------------------------------
    # The old slot is retired; re-verify the new active slot directly 3x
    # over ~5s. Any failure: restart the OLD slot (its tree was never
    # touched), stop the new one, restore .active-slot.
    verify_failed=
    for attempt in 1 2 3; do
      code=$(${pkgs.curl}/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$idlePort/" || true)
      if [ "$code" != "200" ]; then
        echo "dsh-update: flip verification $attempt/3 failed (HTTP ''${code:-none})" >&2
        verify_failed=1
        break
      fi
      [ "$attempt" -eq 3 ] || sleep 2
    done
    if [ -n "$verify_failed" ]; then
      echo "dsh-update: flip failed; ROLLING BACK to dsh@$active" >&2
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.bash}/bin/sh -c "ln -sfn '$activeTree' '${cfg.stateDir}/.src.tmp' && mv -T '${cfg.stateDir}/.src.tmp' '${src}'"
      systemctl stop "dsh@$idle"
      systemctl start "dsh@$active"
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.bash}/bin/sh -c "printf '%s' '$active' > '${activeSlotFile}.tmp' && mv '${activeSlotFile}.tmp' '${activeSlotFile}'"
      echo "dsh-update: flip failed; rolled back; dsh@$active serving again" >&2
      exit 1
    fi

    # Record the slot AS the dsh user: the unit's bounding set strips
    # CAP_DAC_OVERRIDE and /var/lib/dsh is 0700 dsh-owned, so a root write
    # here fails EACCES (observed 2026-11-09).
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.bash}/bin/sh -c "printf '%s' '$idle' > '${activeSlotFile}.tmp' && mv '${activeSlotFile}.tmp' '${activeSlotFile}'"
    # A successful flip supersedes any earlier watchdog rollback evidence.
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.bash}/bin/sh -c "rm -f '${rolledBackFile}' '${watchdogDeadFile}' '${watchdogRollsFile}'"
    echo "dsh-update: active slot is now $idle"
  '';

  # Watchdog decision phase, run AS the dsh user (all state access — the
  # unit's bounding set strips CAP_DAC_OVERRIDE, so root cannot even open
  # the 0700 stateDir's lock). Arg $1 = the root wrapper's health verdict
  # ("ok"|"fail"). Logs go to stderr (journald); the ONLY stdout line is the
  # verdict "promote <slot>" with exit 42. Rollback-episode counting happens
  # here, under the lock, where it is race-free.
  watchdogInner = pkgs.writeShellScript "dsh-watchdog-inner" ''
    set -euo pipefail
    health="''${1:?health verdict required (ok|fail)}"
    if ! exec 9>>${lockFile} 2>/dev/null; then
      echo "dsh-watchdog: state dir unavailable; skipping" >&2
      exit 0
    fi
    if ! ${pkgs.util-linux}/bin/flock -n 9; then
      echo "dsh-watchdog: update holds the state lock; standing down" >&2
      exit 0
    fi

    active=$(${pkgs.coreutils}/bin/cat ${activeSlotFile} 2>/dev/null || echo a)
    if [ "$active" != "b" ]; then active=a; fi
    if [ "$active" = "a" ]; then idle=b; else idle=a; fi

    if [ "$health" = "ok" ]; then
      printf '0' > ${watchdogFailsFile}
      printf '0' > ${watchdogRollsFile}
      rm -f ${watchdogDeadFile}
      exit 0
    fi

    fails=$(( $(${pkgs.coreutils}/bin/cat ${watchdogFailsFile} 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$fails" > ${watchdogFailsFile}
    if [ "$fails" -lt 3 ]; then
      echo "dsh-watchdog: dsh@$active health check failed ($fails/3)" >&2
      exit 0
    fi
    if [ -f ${watchdogDeadFile} ]; then
      echo "dsh-watchdog: both slots down (latched); waiting for manual intervention" >&2
      exit 0
    fi
    rolls=$(${pkgs.coreutils}/bin/cat ${watchdogRollsFile} 2>/dev/null || echo 0)
    if [ "$rolls" -ge 2 ]; then
      echo "dsh-watchdog: 2 rollback episodes without a healthy tick; BOTH slots failing; latching" >&2
      touch ${watchdogDeadFile}
      exit 1
    fi

    lastGood=$(${pkgs.coreutils}/bin/cat ${lastGoodRevFile} 2>/dev/null || true)
    if [ -z "$lastGood" ]; then
      echo "dsh-watchdog: no .last-good-rev recorded yet; refusing blind rollback" >&2
      exit 1
    fi
    idleBuilt=$(${pkgs.coreutils}/bin/cat ${cfg.stateDir}/.built-rev-$idle 2>/dev/null || true)
    idleHead=$(${pkgs.git}/bin/git -C ${cfg.stateDir}/src-$idle rev-parse HEAD 2>/dev/null || true)
    if [ "$idleBuilt" = "$lastGood" ]; then
      echo "dsh-watchdog: src-$idle holds last-known-good $lastGood" >&2
    elif [ -n "$idleBuilt" ] && [ "$idleBuilt" = "$idleHead" ]; then
      # Not the recorded last-good (e.g. the updater had just rebuilt this
      # tree when the active slot died) — but the tree is fully provisioned
      # and self-consistent, so it is still the best known-good candidate.
      echo "dsh-watchdog: src-$idle is a fully built tree at $idleBuilt (last-good $lastGood); promoting as recovery" >&2
    else
      echo "dsh-watchdog: src-$idle not fully provisioned (built ''${idleBuilt:-none}, head ''${idleHead:-none}); refusing rollback" >&2
      exit 1
    fi

    rolls=$(( rolls + 1 ))
    printf '%s' "$rolls" > ${watchdogRollsFile}
    echo "promote $idle"
    exit 42
  '';

  # Automated rollback (root, dsh-watchdog.timer fires every 60s). Three
  # consecutive failed health checks of the ACTIVE slot stop it and promote
  # the OTHER slot — by construction the last-known-good build (each update
  # rebuilds the idle tree, then flips); if the idle tree instead holds a
  # different FULLY BUILT revision (updater raced a crash), it is promoted
  # as recovery. Guards: the update unit (lock or active unit) suspends the
  # watchdog; a missing .last-good-rev or a not-fully-provisioned other tree
  # refuses the rollback; two rollback episodes without a healthy tick, or a
  # failed promotion, latch .watchdog-dead so two broken slots can never
  # thrash — manual intervention clears it (rm the file). All state access
  # goes through the setpriv'd decision inner / explicit setpriv writes: a
  # root read or write under the unit's bounding set fails EACCES (observed
  # 2026-11-09), and a root unit must NOT carry StateDirectory= (systemd
  # re-owns the 0700 dsh dir to root — observed 2026-11-09, same trap the
  # fleet config documents for dsh-update).
  watchdogScript = pkgs.writeShellScript "dsh-watchdog" ''
    set -euo pipefail
    as_dsh() {
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.bash}/bin/sh -c "$1"
    }
    # An update in flight owns the flip; stand down.
    if systemctl is-active --quiet dsh-update.service; then exit 0; fi

    active=$(${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.coreutils}/bin/cat ${activeSlotFile} 2>/dev/null || echo a)
    if [ "$active" != "b" ]; then active=a; fi
    if [ "$active" = "a" ]; then idle=b; else idle=a; fi
    activePort=${toString slotPorts.a}
    idlePort=${toString slotPorts.b}
    if [ "$active" = "b" ]; then
      activePort=${toString slotPorts.b}
      idlePort=${toString slotPorts.a}
    fi

    if ${pkgs.curl}/bin/curl -fsS --max-time 3 "http://127.0.0.1:$activePort/" >/dev/null 2>&1; then
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups ${watchdogInner} ok || exit 1
      exit 0
    fi

    set +e
    verdict=$(${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups ${watchdogInner} fail)
    rc=$?
    set -e
    [ "$rc" -eq 42 ] || { [ "$rc" -eq 0 ] && exit 0; exit "$rc"; }
    idle=$(printf '%s' "$verdict" | ${pkgs.coreutils}/bin/tail -n 1 | ${pkgs.coreutils}/bin/cut -d' ' -f2)
    if [ "$idle" != "a" ] && [ "$idle" != "b" ]; then
      echo "dsh-watchdog: bogus verdict ''$verdict" >&2
      exit 1
    fi
    if [ "$idle" = "a" ]; then active=b; activePort=${toString slotPorts.b}; idlePort=${toString slotPorts.a}
    else active=a; activePort=${toString slotPorts.a}; idlePort=${toString slotPorts.b}; fi
    activeTree=${cfg.stateDir}/src-$active
    idleTree=${cfg.stateDir}/src-$idle

    echo "dsh-watchdog: 3 consecutive failures of dsh@$active; rolling back to dsh@$idle"
    # Point src at the promoted tree so the promoted slot serves its own
    # plugins, then stop the failed slot and promote the other.
    as_dsh "ln -sfn '$idleTree' '${cfg.stateDir}/.src.tmp' && mv -T '${cfg.stateDir}/.src.tmp' '${src}'"
    systemctl stop "dsh@$active" || true
    systemctl start "dsh@$idle"
    promoted=
    waited=0
    while [ "$waited" -lt 60 ]; do
      if ${pkgs.curl}/bin/curl -fsS --max-time 3 "http://127.0.0.1:$idlePort/" >/dev/null 2>&1; then
        promoted=1
        break
      fi
      sleep 2
      waited=$((waited + 2))
    done
    if [ -z "$promoted" ]; then
      echo "dsh-watchdog: dsh@$idle also failed to serve after rollback; BOTH slots down; latching" >&2
      as_dsh "touch '${watchdogDeadFile}'"
      exit 1
    fi
    as_dsh "printf '%s' '$idle' > '${activeSlotFile}.tmp' && mv '${activeSlotFile}.tmp' '${activeSlotFile}'"
    as_dsh "touch '${rolledBackFile}'"
    as_dsh "printf '0' > '${watchdogFailsFile}'"
    echo "dsh-watchdog: rollback complete; dsh@$idle is active"
  '';

  # Boot normalization (dsh-boot-normalize.service, before dsh@a): after a
  # reboot ONLY slot a boots, so the recorded slot and the canonical src
  # symlink must be re-anchored to slot a's tree — a stale .active-slot=b
  # (pre-shutdown state) would otherwise leave src pointing at src-b while
  # a serves, and the watchdog health-checking the wrong port. Skipped when
  # an update grabbed the lock first (exit 75 = its flip wins).
  bootNormalizeInner = pkgs.writeShellScript "dsh-boot-normalize-inner" ''
    set -euo pipefail
    ${layoutMigrate}
    if ! exec 9>>${lockFile} 2>/dev/null; then
      echo "dsh-boot-normalize: state dir unavailable (fresh host?); nothing to anchor yet"
      exit 75
    fi
    if ! ${pkgs.util-linux}/bin/flock -n 9; then
      echo "dsh-boot-normalize: update in flight; leaving slot bookkeeping to it"
      exit 75
    fi
    printf 'a' > ${activeSlotFile}.tmp
    ${pkgs.coreutils}/bin/mv ${activeSlotFile}.tmp ${activeSlotFile}
    ${pkgs.coreutils}/bin/ln -sfn ${slotTree "a"} ${cfg.stateDir}/.src.tmp
    ${pkgs.coreutils}/bin/mv -T ${cfg.stateDir}/.src.tmp ${src}
    echo "dsh-boot-normalize: active slot anchored to a; src -> src-a"
  '';

  bootNormalizeScript = pkgs.writeShellScript "dsh-boot-normalize" ''
    set -euo pipefail
    # As the dsh user: the unit's bounding set strips CAP_DAC_OVERRIDE and
    # /var/lib/dsh is 0700 dsh-owned — root cannot even traverse it
    # (observed 2026-11-09 on dsh-update).
    set +e
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups ${bootNormalizeInner}
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || [ "$rc" -eq 75 ] || exit "$rc"
  '';

  dshServiceConfig = {
    User = "dsh";
    Group = "dsh";
    StateDirectory = lib.removePrefix "/var/lib/" cfg.stateDir;
    StateDirectoryMode = "0700";
    UMask = "0077";
    EnvironmentFile = "-/etc/nix/dsh-env";
    # Bind nothing beyond loopback unless you accept the risk: this UI can
    # execute shell on this machine; caddy terminates the tailnet audience.
    Environment = [
      "HOME=${home}"
      "DSH_HOME=${home}"
      "DSH_AGENTS_HOME=${home}/agents"
      "DSH_TELEMETRY_DISABLED=1"
      "COREPACK_HOME=${corepackHome}"
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
      "LD_LIBRARY_PATH=${gccLib}"
      "PATH=${home}/.nix-profile/bin:${nodeDir}/bin:${toolPath}:/run/current-system/sw/bin"
      # In-session harness git (fetch/push on the fork) needs the deploy key
      # non-interactively. The value contains spaces: escapeShellArg keeps
      # systemd from splitting it into bogus assignments (observed on warden).
      "GIT_SSH_COMMAND=${lib.escapeShellArg sshCommand}"
    ];
    # '-' prefix: the slot's own tree does not exist on first boot —
    # ExecStartPre's provision step creates it; systemd then chdirs for
    # ExecStart. Per-slot (NOT the canonical symlink): a slot always serves
    # its OWN build, whatever src currently points at.
    WorkingDirectory = "-${cfg.stateDir}/src-%i";
    ExecStartPre = "${pkgs.util-linux}/bin/flock ${lockFile} ${provisionScript} %i";
    TimeoutStartSec = "45min";
    Restart = "on-failure";
    RestartSec = "5s";
    NoNewPrivileges = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ReadWritePaths = [ cfg.stateDir ];
    ProtectHome = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    RestrictSUIDSGID = true;
    RestrictRealtime = true;
    LockPersonality = true;
    SystemCallArchitectures = "native";
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
    ];
    CapabilityBoundingSet = "";
    # MemoryDenyWriteExecution stays off: V8 JITs.
  };
in
{
  options.services.dsh = {
    enable = lib.mkEnableOption "dsh — the web AI harness, auto-updating from github:wylited/deepseek-harness and served tokenless to the tailnet via ds.ts.wyli.tech";

    port = lib.mkOption {
      type = lib.types.port;
      default = 3080;
      description = "Loopback port of blue-green slot a; slot b takes port+1. Caddy's ds.ts.wyli.tech vhost health-checks both.";
    };

    trustedHosts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra --trusted-host authorities passed to the web invocation (e.g. the tailnet vhost name). Feeds webStartup.trustedHosts: the connection layer's trusted set AND the dashboard host fence.";
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/dsh";
      description = "Persistent state: the fork clone, vendored node, profile home, pnpm/corepack caches.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "/var/lib/" cfg.stateDir;
        message = "services.dsh.stateDir must live under /var/lib (backed by systemd StateDirectory).";
      }
    ];

    users.users.dsh = {
      isSystemUser = true;
      group = "dsh";
      description = "dsh web harness service user";
    };
    users.groups.dsh = { };

    systemd.services = (lib.mapAttrs'
      (slot: port: lib.nameValuePair "dsh@${slot}" {
        description = "dsh — web AI harness, blue-green slot ${slot} (127.0.0.1:${toString port})";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        # Slot a is the only boot-enabled slot: on first boot there is no
        # .active-slot, the default active slot is a, and b exists solely to
        # receive flips (booting both would race the shared profile tree).
        wantedBy = lib.optionals (slot == "a") [ "multi-user.target" ];
        serviceConfig = dshServiceConfig // {
          # Same boot the repo's ./dsh wrapper performs (pnpm dsh = node
          # --import tsx/esm apps/cli/src/bin.ts); the connection layer's trust
          # fence comes from the profile, the dashboard host fence from these
          # --trusted-host flags (webStartup.trustedHosts).
          ExecStart =
            "${nodeDir}/bin/node --import tsx/esm apps/cli/src/bin.ts web --no-open --host ${bind} --port ${toString port}"
            + lib.concatMapStrings (h: " --trusted-host ${h}") cfg.trustedHosts;
        };
      })
      slotPorts) // {
      dsh-update = {
        description = "dsh — fast-forward the fork clone, rebuild, flip blue-green slots";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${updateScript}";
        TimeoutStartSec = "45min";
        # NO StateDirectory here: this is a ROOT unit and systemd would
        # re-own the 0700 dsh dir to root on every run (observed 2026-11-09),
        # locking the dsh user out. The slot units own creation/ownership.
        Environment = [ "PATH=/run/current-system/sw/bin" ];
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ "-${cfg.stateDir}" ];
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        # CapabilityBoundingSet stays: the root wrapper setpriv-drops to the
        # dsh uid, which needs CAP_SETUID/CAP_SETGID (an empty bounding set
        # fails setpriv with EPERM — observed on warden).
        CapabilityBoundingSet = [
          "CAP_SETUID"
          "CAP_SETGID"
        ];
      };
      };
      dsh-watchdog = {
        description = "dsh — watchdog: 3 failed health checks of the active slot roll back to the last-known-good slot";
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${watchdogScript}";
          # NO StateDirectory: root unit — systemd would re-own the 0700 dsh
          # dir to root on every 60s tick (observed 2026-11-09). State writes
          # go through the setpriv'd inner / explicit setpriv lines.
          Environment = [ "PATH=/run/current-system/sw/bin" ];
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ReadWritePaths = [ "-${cfg.stateDir}" ];
          ProtectHome = true;
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;
          RestrictSUIDSGID = true;
          RestrictRealtime = true;
          LockPersonality = true;
          SystemCallArchitectures = "native";
          CapabilityBoundingSet = [
            "CAP_SETUID"
            "CAP_SETGID"
          ];
        };
      };
      dsh-boot-normalize = {
        description = "dsh — anchor the active slot and canonical src symlink to slot a at boot";
        before = [ "dsh@a.service" ];
        wantedBy = [ "multi-user.target" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${bootNormalizeScript}";
          # NO StateDirectory: root unit — systemd would re-own the 0700 dsh
          # dir to root at boot (observed 2026-11-09; the slot units own the
          # dir).
          Environment = [ "PATH=/run/current-system/sw/bin" ];
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ReadWritePaths = [ "-${cfg.stateDir}" ];
          ProtectHome = true;
          RestrictSUIDSGID = true;
          LockPersonality = true;
          SystemCallArchitectures = "native";
          CapabilityBoundingSet = [
            "CAP_SETUID"
            "CAP_SETGID"
          ];
        };
      };
    };

    # Self-redeploy: the in-session harness runs as dsh and may start the
    # update unit itself — and nothing else.
    security.polkit.enable = true;
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id == "org.freedesktop.systemd1.manage-units"
            && subject.user == "dsh") {
          var unit = action.lookup("unit");
          if (unit == "dsh-update.service") {
            return polkit.Result.YES;
          }
        }
      });
    '';

    systemd.timers.dsh-update = {
      description = "dsh — daily auto-update timer";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        RandomizedDelaySec = "20m";
        Persistent = true;
      };
    };

    # Health sweep every minute at :00; three consecutive failures of the
    # active slot trip the rollback (worst-case detection ≈3 min).
    systemd.timers.dsh-watchdog = {
      description = "dsh — 60s watchdog timer";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "*:*:00";
        AccuracySec = "5s";
        Persistent = false;
      };
    };
  };
}
