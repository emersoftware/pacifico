# Releases

1. Update the version in the root and workspace `package.json` files, the manifests under `packages/agents/plugin`, and `PLUGIN_VERSION` in `packages/agents/src/setup.ts`.
2. Run `bun run generate-plugin-embed`, then the checks in [TESTING.md](TESTING.md).
3. Commit and push a matching `vX.Y.Z` tag. The Release workflow builds and tests native binaries on macOS and Linux for ARM64 and x86-64.
4. Download the four release archives and verify them against `SHA256SUMS`. Each archive contains `pacifico` and `LICENSE`.
5. Update the version and four checksums in [the Homebrew formula](https://github.com/emersoftware/homebrew-tap/blob/main/Formula/pacifico.rb), then commit and push the tap.
6. Verify `brew upgrade emersoftware/tap/pacifico` and `brew test emersoftware/tap/pacifico`.

The workflow also accepts an existing tag through manual dispatch. Release assets are published only after all four native executable tests pass. The Homebrew tap is updated separately.
