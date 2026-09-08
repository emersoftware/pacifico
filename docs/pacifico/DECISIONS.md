# Design decisions

## Keep TypeScript and compile with Bun

A Go or Rust port could reduce runtime size, but would require reimplementing parsers, MCP integration, memory, and reporting. Keeping TypeScript preserves the tested engine and produces a standalone executable with Bun. There is no measured requirement that justifies a language rewrite.

## Organize by responsibility

Generic domain/application/infrastructure layers would make dependency inversion explicit, but introduce additional interfaces without alternate implementations. Pacifico instead uses a modular monorepo: core owns session formats and storage, agents owns integrations, and CLI owns terminal interaction.

This is not a claim of strict Clean Architecture. Some inherited core modules include command and report presentation logic. Future extractions should hide independently changing information.

## Separate the product namespace

The command is `pacifico`, with `install` and the compatibility alias `setup`. Durable data lives in `~/.local/share/pacifico`; rebuildable indexes live in `~/.cache/pacifico`. The MCP/plugin identifier is also `pacifico`.

The inherited `SESSIONS_*` environment variables remain available to select sources and isolate tests. Existing `sessions` data and integrations are not migrated or deleted.

## Distribute under a personal account

The public owner is `emersoftware`. Source lives in `emersoftware/pacifico`, binaries in GitHub Releases, and the Homebrew formula in `emersoftware/homebrew-tap`. No shared backend is required.

Release binaries include Bun. Homebrew integration paths use its stable `opt` alias, verified against the executable performing installation. This preserves registrations when a previous version is removed.

## Keep background work optional

Installation configures detected clients. Indexing happens during retrieval or through the optional macOS LaunchAgent. The daemon is opt-in. Session-start hooks have been removed.

The daemon uses periodic launchd jobs instead of a resident watcher. This reuses incremental discovery, recovers changes missed by file watchers, and leaves no idle runtime between passes. See [DAEMON.md](DAEMON.md).

## Preserve durable data

The index can be rebuilt. Archived transcripts and human memory decisions cannot necessarily be recovered from elsewhere. Uninstall therefore preserves both. The archive keeps the latest imported snapshot rather than unlimited versions.

## Open questions

Cross-machine synchronization would require stable session identity, reconciliation, transport, and authorization. Team access adds project permissions and retention rules. Those are separate product work, not implied by local archival support.

## Remove inherited automation and model requirements

Two alternatives were considered: consolidate the seven inherited skills into one Mosaic-style routing skill, or remove them and put the retrieval contract in MCP itself. We chose removal: one discovery path is easier to maintain than parallel skill and prompt instructions. The Mosaic workflow remains a design reference, not a runtime dependency or a copied local installation.

Ollama probing, embedding generation, vector ranking, hook execution, and hook installation are removed. A v12-to-v13 migration drops only derived vector data and preserves text index rows. Upgrade cleanup removes the exact old Pacifico hook command and installer-owned skill links, preserving other tools' settings. The installer now embeds only integration manifests and MCP configuration.

MCP now exposes five tools with explicit modes. Keeping twelve separate tools preserves narrow schemas but repeats discovery and reading concepts. Five task-oriented tools reduce that overlap while retaining memory retrieval and review. Mode-specific validation rejects unrelated parameters, and discriminated output schemas preserve each payload shape. Old tool names are removed rather than retained as advertised aliases. The contract is documented in MCP-CURATION.md. Memory writes remain explicit CLI operations.
