# dsh on Nix — preparation notes (`nix/` on branch `wyli`)

**Status: skeleton.** Evaluates to a real `.drv` for `x86_64-linux` (the only
supported target; re-add platforms via the `nodeSrc` attrset + `meta.platforms`
if ever needed). Nothing has been built end-to-end yet. This file is the
loop-closer.

## Why this is weird (the constraints that shaped it)

1. **Node is version-pinned to an official binary, not nixpkgs.** dsh's boot
   probes Node loader internals via `node-addon-require-builtin`; the prebuilt
   binding rejects the code layout of Node ≥ 24.21 (reproduced on nixpkgs-style
   24.21.0 and official 24.22.2; 24.9.0 works — full story in `../SETUP.md`).
   nixpkgs `nodejs_24` currently resolves to **24.21.0**, i.e. exactly the
   broken build. When upstream bumps the addon, delete the `node` let-block and
   swap `nodejs_24` back in.
2. **`allowBuilds` patched** (`lefthook: true → false`): lefthook's postinstall
   installs git hooks; there is no `.git` in a nix build. The rest of the
   repo's mapping (esbuild, node-pty, koffi, subprocess-local) runs inside the
   sandbox.
3. **Builds the pinned upstream rev**, not the wyli tree — the wyli delta
   (wrapper + SETUP.md) is what `bin/dsh` in the derivation reimplements.
   Bump the `fetchFromGitHub` rev + `hash` to track upstream.
4. **Runtime state is not the nix store**: `bin/dsh` defaults `DSH_HOME` to
   `${XDG_STATE_HOME:-~/.local/state}/dsh-home`.

## Fill-in loop (to finish the build)

```sh
cd nix
nix build .#packages.x86_64-linux.dsh 2>&1 | grep -E "got:|specified:"
# paste the `got:` hash into pnpmDeps.hash; re-run until the real build starts
```

Hash status:
- upstream src @ fcc0ad46: **done** (`sha256-cY9Zi12ePt95XIFXOESJOYMlVBpvyNjul4bEkuCSdFk=`)
- node tarball (linux-x64): **done** (verified via `nix store prefetch-file`)
- `pnpmDeps`: fake (`lib.fakeHash`) — first build prints the real one

## Open problems / TODO (expected, not blockers to iterate on)

- [ ] pnpm 12 (nixpkgs) vs repo pin 11.28.5 — `pnpm` warns on mismatch; watch
      for engine-strict or lockfile-version complaints on first real build.
- [ ] Native builds under the sandbox: `node-pty` (node-gyp + python3),
      `koffi`, esbuild — node-gyp must find headers in the pinned node dist
      (`include/node` is in the binary tarball); if it misses, set
      `npm_config_nodedir` to the node derivation.
- [ ] `pnpm run build` = 10 build gates (typert host bundles, native runtime);
      ran fine on the local checkout with the same node pin, but never inside
      a nix sandbox. Watch for `HOME`/git assumptions.
- [ ] Linux fixup unverified: official node binaries need interpreter +
      libstdc++ patchelf on NixOS (`postFixup` does this, untested).
- [ ] First boot from a read-only store path: profiles auto-init into
      `$DSH_HOME` (stock templates) — confirm nothing writes into the store
      path itself.
- [ ] `native/` (rust?) — confirm whether `pnpm run build` needs cargo; if so,
      add cargo hooks.

## Relationship to upstream / the wyli branch

`wyli` = `upstream/master` + thin commits (wrapper, SETUP.md, this `nix/`).
Tracking: `git pull` rebases the wyli commits onto fresh upstream master. To
re-pin the nix package after an upstream pull: update `rev`/`hash` in
`package.nix` to the new upstream master commit.
