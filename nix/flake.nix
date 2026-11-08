# dsh — nix packaging skeleton (branch `wyli`)
#
# Self-contained flake: build the pinned upstream rev for this machine.
# Status + fill-in loop: ./README.md
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }: {
    packages.x86_64-linux.dsh =
      nixpkgs.legacyPackages.x86_64-linux.callPackage ./package.nix { };
  };
}
