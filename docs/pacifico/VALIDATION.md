# Validation

## Released executable: 0.2.0

The suite passes 1,145 tests, with eight optional corpus skips and no failures (3,345 assertions across 82 files). Type checking, lint, formatting, architecture checks, compilation, and native binary smoke passed.

Protocol tests check the exact five-tool inventory, every merged mode, populated and empty payloads, date filtering before result limits, pagination, invalid parameters, retired tool rejection, and unchanged memory records. The native executable smoke confirms the same inventory, installation cleanup, search/read, archive recovery, and durable uninstall behavior.

The release workflow passed native executable smoke tests on macOS ARM64, macOS x86-64, Linux ARM64, and Linux x86-64. All four downloaded archives matched SHA256SUMS and contained the executable, LICENSE, and NOTICE. Homebrew upgrade from 0.1.1 to 0.2.0 and formula tests passed on macOS ARM64. The installed executable reported version 0.2.0 and exactly five MCP tools through a real stdio handshake. Client installation completed, and the existing daemon remained scheduled with a successful import. The accepted API migration is documented in MCP-CURATION.md.

## Earlier removal pass

After removing Ollama, hook execution, bundled skills, and MCP prompts, the suite has 1,154 passing tests, eight optional real-corpus skips, and no failures (3,494 assertions across 82 files). Type checking, lint, formatting, architecture checks, compilation, and native binary smoke passed.

The smoke test seeds a retired hook beside another command and an old Pi skill link, installs twice, and verifies scoped cleanup. It confirms zero prompt capability, twelve tools, successful search/read, archive recovery after native-source removal, and preservation of durable data during uninstall. A schema migration test proves v12-to-v13 removes only the vector table while retaining existing session and text-index rows. A cached memory-store connection in the inherited schema test was reset before fixture seeding to make full-suite execution independent of test-file order.

The subsequent five-tool pass above supersedes this intermediate MCP inventory.

## Released executable: 0.1.1

The source suite completed with 1,192 passing tests and 9 optional skips. Type checking, lint, formatting, architecture checks, and the compiled-binary smoke test passed.

The release workflow built and exercised each native executable on macOS ARM64, macOS x86-64, Linux ARM64, and Linux x86-64. All four tarballs were downloaded and checked against the published SHA-256 values. Each contains the executable, LICENSE, and NOTICE.

Homebrew installation and upgrade from 0.1.0 to 0.1.1 were exercised on macOS ARM64, including formula tests. MCP configuration and launchd registration were verified to use Homebrew's stable `opt` path. A real MCP handshake exposed 12 tools and a search completed successfully. The background importer completed successfully after installation.

## Executable smoke coverage

The smoke test executes the compiled program against synthetic sources and client configuration:

1. Install twice and preserve unrelated MCP servers.
2. Verify the installed executable path.
3. Connect over MCP stdio and check server identity and tools.
4. Search and read messages with validated response schemas.
5. Run concurrent import processes.
6. Preserve native source bytes, then rebuild after a synthetic source is removed.
7. Uninstall while retaining archives, memory, and unrelated configuration.

Dedicated coverage checks stable Homebrew aliases across removal of an old keg, rejects aliases pointing to a different executable, and preserves standalone paths.

## Other coverage

The inherited suite covers transcript parsing, search, archive behavior, subagents, Pi branches, memory, TOML/JSON configuration, and MCP lifecycle. The native launchd smoke uses temporary sources and a unique label, then removes its service.

The nine optional real-corpus/Ollama tests were skipped and are not counted as successful checks. Native release tests do not establish compatibility with every OS or harness version. Homebrew installation was executed on macOS ARM64; the other platforms were verified through their native executable integration tests.

## Reproduce

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun run check:architecture
bun test
bun run build
bun run test:binary
```

Website checks run separately from `apps/site`. Local packaging writes ignored artifacts under `dist/`; it does not replace the public Homebrew formula.
