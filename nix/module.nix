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
# Serving is blue-green: two concrete instances dsh@a / dsh@b (loopback 3080 /
# 3081, see slotPorts) share one clone + node + profile tree; exactly one is
# active at a time and the choice is recorded in <stateDir>/.active-slot
# (default a, the only boot-enabled slot). The update wrapper flips slots:
# start the idle one, wait for HTTP 200 on its port (the idle slot's
# ExecStartPre provision is a no-op — the built-marker gate is global across
# both instances), stop the active one, record the new slot. A failed health
# wait rolls back by leaving the old slot serving and exiting non-zero.
# Caddy fronts BOTH ports with active health checks (fleet ingress module),
# so the flip never drops the vhost.
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

  src = "${cfg.stateDir}/src";
  nodeDir = "${cfg.stateDir}/node";
  home = "${cfg.stateDir}/home";
  lockFile = "${cfg.stateDir}/.lock";
  builtMarker = "${cfg.stateDir}/.built-rev";
  activeSlotFile = "${cfg.stateDir}/.active-slot";
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
          - ai.ts.wyli.tech
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

  # Idempotent provisioning, run as the dsh user under the state lock:
  # clone, vendored node, profile reconciliation, deps, branded client build.
  # Callers (both dsh@a/dsh@b ExecStartPre / the update unit) hold the flock;
  # the built-marker gate is global, so whichever slot starts after an update
  # no-ops here.
  provisionScript = pkgs.writeShellScript "dsh-provision" ''
    set -euo pipefail
    stateDir=${cfg.stateDir}
    src=${src}
    nodeDir=${nodeDir}
    profileDir=${home}/profiles/web

    mkdir -p ${corepackHome} ${home} "$profileDir"

    # --- source clone -------------------------------------------------------
    if [ ! -d "$src/.git" ]; then
      ${pkgs.git}/bin/git clone --branch ${branch} --single-branch ${repoUrl} "$src"
    fi

    # --- ssh host trust for github.com --------------------------------------
    # The clone's origin is SSH (RW deploy key) and the in-session harness
    # pushes through GIT_SSH_COMMAND; pre-seed the host key so the first
    # unattended fetch never stalls on a host-key prompt.
    sshDir=${cfg.stateDir}/.ssh
    mkdir -p "$sshDir"
    touch "$sshDir/known_hosts"
    if ! ${pkgs.gnugrep}/bin/qs '^github.com ' "$sshDir/known_hosts" 2>/dev/null; then
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
      if ! ${pkgs.coreutils}/bin/cmp -s "${profileStore}/$name" "$profileDir/$name"; then
        ${pkgs.coreutils}/bin/install -m 600 "${profileStore}/$name" "$profileDir/$name"
        dirty=1
      fi
    done

    # --- harness workspace alias ---------------------------------------------
    # Profiles cannot declare named workspaces (workspaces are runtime UI
    # records created via workspace.create — recon 2026-11-09). Convention:
    # ${home}/harness is a stable alias for the fork checkout the harness
    # redeploys from — no git worktree, no second clone.
    ln -sfn ${src} ${home}/harness

    # Profile deps: one registry package + link: plugins into the clone.
    if [ "$dirty" -eq 1 ] || [ ! -d "$profileDir/node_modules" ]; then
      (cd "$profileDir" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=${corepackHome} ${nodeDir}/bin/corepack pnpm install)
    fi

    # --- repo deps + branded client build (first boot + after each update) --
    head_rev=$(${pkgs.git}/bin/git -C "$src" rev-parse HEAD)
    built_rev=$(${pkgs.coreutils}/bin/cat ${builtMarker} 2>/dev/null || true)
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
      echo "$head_rev" > ${builtMarker}.tmp
      ${pkgs.coreutils}/bin/mv ${builtMarker}.tmp ${builtMarker}
    fi
  '';

  # Fast-forward check + provision, run AS the dsh user (inside setpriv) under
  # the state lock. Exit 42 = the active build is stale (HEAD moved and/or the
  # built-marker no longer names HEAD) and provisioning succeeded; the root
  # wrapper then flips the blue-green slots. Never resets or force-updates.
  updateInner = pkgs.writeShellScript "dsh-update-inner" ''
    set -euo pipefail
    exec 9>>${lockFile}
    ${pkgs.util-linux}/bin/flock -x 9

    if [ ! -d ${src}/.git ]; then
      echo "dsh-update: no clone yet; dsh@a owns first provisioning"
      exit 0
    fi

    old=$(${pkgs.git}/bin/git -C ${src} rev-parse HEAD)
    ${pkgs.git}/bin/git -C ${src} fetch origin ${branch}
    if ! ${pkgs.git}/bin/git -C ${src} merge --ff-only origin/${branch}; then
      echo "dsh-update: origin/${branch} is not a fast-forward from HEAD; refusing" >&2
      exit 1
    fi
    new=$(${pkgs.git}/bin/git -C ${src} rev-parse HEAD)
    built=$(${pkgs.coreutils}/bin/cat ${builtMarker} 2>/dev/null || true)
    if [ "$old" = "$new" ] && [ "$new" = "$built" ]; then
      echo "dsh-update: already at $new"
      exit 0
    fi
    if [ "$old" != "$new" ]; then
      echo "dsh-update: fast-forwarded $old -> $new; rebuilding"
    else
      echo "dsh-update: built-marker stale (head $new, built ''${built:-none}); rebuilding"
    fi
    ${provisionScript}
    exit 42
  '';

  # Root wrapper: drop to the dsh uid for everything touching stateDir; on a
  # successful rebuild (exit 42) flip the blue-green slots with zero vhost
  # downtime. The active slot is never stopped before its replacement answers
  # 200; a failed health wait rolls back (old slot keeps serving) non-zero.
  updateScript = pkgs.writeShellScript "dsh-update" ''
    set -euo pipefail
    set +e
    ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
      ${pkgs.coreutils}/bin/env HOME=${home} COREPACK_HOME=${corepackHome} COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      LD_LIBRARY_PATH=${gccLib} \
      GIT_SSH_COMMAND=${lib.escapeShellArg sshCommand} \
      PATH=${nodeDir}/bin:${toolPath}:/run/current-system/sw/bin \
      ${updateInner}
    rc=$?
    set -e
    if [ "$rc" -eq 42 ]; then
      # Read the slot AS the dsh user: the unit's bounding set strips
      # CAP_DAC_OVERRIDE and /var/lib/dsh is 0700 dsh-owned — root cannot
      # even traverse it (observed 2026-11-09: empty read misdetected the
      # active slot and no-op'd the flip).
      active=$(${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.coreutils}/bin/cat ${activeSlotFile} 2>/dev/null || true)
      if [ "$active" != "b" ]; then active=a; fi
      if [ "$active" = "a" ]; then idle=b; else idle=a; fi
      idlePort=${toString slotPorts.b}
      if [ "$idle" = "a" ]; then idlePort=${toString slotPorts.a}; fi

      echo "dsh-update: bringing up dsh@$idle on 127.0.0.1:$idlePort"
      systemctl start "dsh@$idle"

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
        systemctl stop "dsh@$idle"
        exit 1
      fi

      echo "dsh-update: dsh@$idle healthy; retiring dsh@$active"
      systemctl stop "dsh@$active"
      # Record the slot AS the dsh user: the unit's bounding set strips
      # CAP_DAC_OVERRIDE and /var/lib/dsh is 0700 dsh-owned, so a root write
      # here fails EACCES (observed 2026-11-09).
      ${pkgs.util-linux}/bin/setpriv --reuid=dsh --regid=dsh --init-groups \
        ${pkgs.bash}/bin/sh -c "printf '%s' '$idle' > '${activeSlotFile}.tmp' && mv '${activeSlotFile}.tmp' '${activeSlotFile}'"
      echo "dsh-update: active slot is now $idle"
    elif [ "$rc" -ne 0 ]; then
      exit "$rc"
    fi
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
      "PATH=${nodeDir}/bin:${toolPath}:/run/current-system/sw/bin"
      # In-session harness git (fetch/push on the fork) needs the deploy key
      # non-interactively.
      "GIT_SSH_COMMAND=${sshCommand}"
    ];
    # '-' prefix: the src clone does not exist on first boot — ExecStartPre's
    # provision step creates it; systemd then chdirs for ExecStart.
    WorkingDirectory = "-${src}";
    ExecStartPre = "${pkgs.util-linux}/bin/flock ${lockFile} ${provisionScript}";
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
    enable = lib.mkEnableOption "dsh — the web AI harness, auto-updating from github:wylited/deepseek-harness and served tokenless to the tailnet via ai.ts.wyli.tech";

    port = lib.mkOption {
      type = lib.types.port;
      default = 3080;
      description = "Loopback port of blue-green slot a; slot b takes port+1. Caddy's ai.ts.wyli.tech vhost health-checks both.";
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
          # --import tsx/esm apps/cli/src/bin.ts); the trust fence comes from
          # the profile.
          ExecStart =
            "${nodeDir}/bin/node --import tsx/esm apps/cli/src/bin.ts web --no-open --host ${bind} --port ${toString port}";
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
        StateDirectory = lib.removePrefix "/var/lib/" cfg.stateDir;
        StateDirectoryMode = "0700";
        Environment = [ "PATH=/run/current-system/sw/bin" ];
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.stateDir ];
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
  };
}
