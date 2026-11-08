# dsh — flake entrypoint (branch `wyli`).
#
# Lives at the repo ROOT so other flakes can consume this tree directly:
#
#   inputs.dsh.url = "github:wylited/deepseek-harness/wyli";
#   imports = [ inputs.dsh.nixosModules.dsh ];
#
# `nixosModules.dsh` deploys the auto-updating web harness service (see
# ./nix/module.nix — the service provisions itself from a git checkout of
# this repo, so the Nix closure only pins the Node tarball + profile config).
# `packages.x86_64-linux.dsh` is the classic nix-built derivation
# (./nix/package.nix); the module does not depend on it.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: {
    packages.x86_64-linux.dsh =
      nixpkgs.legacyPackages.x86_64-linux.callPackage ./nix/package.nix { };

    nixosModules.dsh = import ./nix/module.nix;
  };
}
