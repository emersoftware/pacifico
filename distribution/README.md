# Distribution

Install the public executable with:

```sh
brew install emersoftware/tap/pacifico && pacifico install
```

The formula lives in [emersoftware/homebrew-tap](https://github.com/emersoftware/homebrew-tap). GitHub Releases contain four tarballs, each with the standalone executable, and LICENSE, plus SHA256SUMS.

## Release process

1. Update the version in the root and workspace package.json files, plugin manifests, and PLUGIN_VERSION in packages/agents/src/setup.ts. Regenerate embedded plugin files and run the checks documented in docs/pacifico/VALIDATION.md.
2. Commit the version and push a matching `vX.Y.Z` tag. The Release workflow builds and runs the executable smoke test on native macOS and Linux runners for both architectures.
3. The workflow publishes the release and checksums only after all four executable smoke tests pass.
4. Update the tap formula version and all four checksums from the release assets, commit, and push. Test installation with Homebrew.

The workflow can also rebuild an existing tag through `workflow_dispatch`. It publishes only after every platform build and smoke test succeeds. Cross-repository tap updates are optional: set `HOMEBREW_TAP_REPOSITORY` and the scoped `HOMEBREW_TAP_TOKEN` secret to enable the existing update job. Never store a token in this repository. Without that configuration, update the tap manually after publishing the release.

## Local packaging

```sh
bun run build
bun run test:binary
bun run package:local
```

This produces a host tarball, its checksum, and `dist/local-tap/Formula/pacifico.rb`. The local formula points to the local artifact and is ignored by Git. It must not replace the public tap formula.
