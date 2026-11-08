# DeepSeek Harness (dsh) — thin research packaging for branch `wyli`.
# STATUS: skeleton, intentionally not complete. Open problems + fill-in loop:
#   ./README.md (same directory).
# Builds the pinned UPSTREAM rev (fcc0ad46, release 0.2.2-rc.1) — identical
# tree to wyli minus the wrapper/docs commit, which this derivation
# reimplements natively (bin/dsh wrapper + DSH_HOME default).
{
  lib,
  stdenv,
  fetchurl,
  fetchFromGitHub,
  patchelf,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  python3,
}:

let
  # ---- node pin (the one hard constraint) ---------------------------------
  # dsh's boot probes Node loader internals via node-addon-require-builtin;
  # its prebuilt binding rejects the code layout of Node >= 24.21
  # (reproduced: nixpkgs-style 24.21.0 and official 24.22.2 both fail with
  # "Unsupported/no-getter", 24.9.0 works — see ../SETUP.md). nixpkgs
  # nodejs_24 currently IS 24.21.0, so nixpkgs node is unusable here until
  # upstream bumps the addon. Pin the official v24.9.0 binary instead.
  nodeVersion = "24.9.0";
  nodeSrc.x86_64-linux = {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz";
    hash = "sha256-9S7FDpWdctXGgNlzFCCyZhzSqAcOlMc2m23fzYtyeL4=";
  };

  node = stdenv.mkDerivation {
    pname = "nodejs-dsh-pinned";
    version = nodeVersion;
    src = fetchurl (
      nodeSrc.${stdenv.hostPlatform.system}
        or (throw "dsh: no pinned node for ${stdenv.hostPlatform.system}")
    );

    # tarball root is node-v${version}-<platform>/ — normalize generically
    setSourceRoot = ''sourceRoot=$(echo node-v*)'';

    dontConfigure = true;
    dontBuild = true;

    nativeBuildInputs = lib.optionals stdenv.isLinux [ patchelf ];

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r ./* $out/
      runHook postInstall
    '';

    # Official linux binaries assume a system loader + libstdc++ — NixOS has
    # neither at those paths. darwin binaries reference /usr/lib/dyld, which
    # macOS always provides, so no fixup needed there. UNVERIFIED on linux
    # (no fleet build yet) — see ./README.md.
    postFixup = lib.optionalString stdenv.isLinux ''
      patchelf --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" $out/bin/node
      patchelf --set-rpath "${stdenv.cc.cc.lib}/lib" $out/bin/node
    '';
  };

  # lefthook's postinstall installs *git hooks* — there is no .git in a nix
  # build, so deny it for the nix context only (runtime doesn't need it).
  patchWorkspace = ''
    substituteInPlace pnpm-workspace.yaml --replace-fail "lefthook: true" "lefthook: false"
  '';
in
stdenv.mkDerivation (finalAttrs: {
  pname = "dsh";
  version = "0.2.2-rc.1";

  src = fetchFromGitHub {
    owner = "deepseek-ai";
    repo = "deepseek-harness";
    rev = "fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159";
    hash = "sha256-cY9Zi12ePt95XIFXOESJOYMlVBpvyNjul4bEkuCSdFk=";
  };

  # nixpkgs pnpm (12.9.0) vs repo packageManager pin (11.28.5): pnpm warns on
  # mismatch but proceeds; the pnpm-12 fetcher needs fetcherVersion = 4.
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 4; # pnpm 12 fetcher (26.11 nixpkgs)
    hash = lib.fakeHash; # TODO: `nix build` prints the real hash — paste it here
  };

  nativeBuildInputs = [
    pnpmConfigHook
    python3 # node-pty / koffi native builds (node-gyp needs python)
  ];

  prePatch = patchWorkspace;

  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR
    export PATH=${node}/bin:$PATH
    pnpm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/dsh $out/bin
    cp -r . $out/share/dsh/
    rm -rf $out/share/dsh/.git
    cat > $out/bin/dsh <<WRAP
      #!${stdenv.shell}
      export PATH="${node}/bin:\$PATH"
      export DSH_HOME="\''${DSH_HOME:-\''${XDG_STATE_HOME:-\''${HOME}/.local/state}/dsh-home}"
      export DSH_AGENTS_HOME="\$DSH_HOME/agents"
      exec "${node}/bin/node" --import tsx/esm "$out/share/dsh/apps/cli/src/bin.ts" "\$@"
WRAP
    chmod +x $out/bin/dsh
    runHook postInstall
  '';

  meta = {
    description = "DeepSeek Harness — plugin-based AI coding agent (dsh)";
    homepage = "https://github.com/deepseek-ai/deepseek-harness";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "dsh";
  };
})
