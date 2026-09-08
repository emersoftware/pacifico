# Feature map

Pacifico builds on the MIT-licensed `nicknisi/sessions` engine. These paths refer to the current monorepo.

| Feature               | Implementation                                          | Scope                                                        |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Claude Code and Codex | `packages/core/src/parser.ts`, `scanner.ts`, `cache.ts` | Native transcript parsing                                    |
| Pi and OpenCode       | `pi-tree.ts`, `opencode.ts`, report parsers             | Tree-aware Pi reads; read-only OpenCode SQLite access        |
| Message search        | SQLite FTS5 in `cache.ts`                               | BM25 ranking and message references                          |
| Exhaustive search     | `grepSessions`                                          | Literal and regular-expression matching                      |
| Contextual reading    | `parser.ts`, `digest.ts`                                | Pagination and compact session digests                       |
| Durable archive       | `vault/archive.ts`                                      | Local snapshots and manifest                                 |
| Incremental updates   | `cache.ts`                                              | Size/mtime comparison; changed files are reprocessed         |
| Curated memory        | `memory/`                                               | Candidates, approval, scope, export, and import              |
| MCP                   | `packages/agents/src/mcp.ts`                            | 5 tools and session resources; no prompts                    |
| Metrics and reports   | `report/`, `wrapped/`                                   | Usage analysis and estimated pricing                         |
| Resume commands       | `buildResumeCommand` and selector                       | Provider-specific continuation where supported               |
| Installation          | `packages/agents/src/setup.ts`                          | Pacifico namespace, detected-client setup, conflict handling |
| Distribution          | GitHub Releases and Homebrew                            | Standalone macOS/Linux binaries for ARM64 and x86-64         |
| Background indexing   | `packages/agents/src/daemon.ts`                         | Optional macOS LaunchAgent; single-pass import on Linux      |

## Local flow

A query discovers sources, refreshes changed files, and preserves archive copies before reading the index. MCP returns bounded fragments and references for follow-up reads. Parsing and text search do not require an LLM. Search is text-only and makes no embedding-service requests.

## Boundaries

Updates are incremental by file; they are not universally append-only by byte offset. Subagents, Pi branches, and large tool results require format-aware handling. Existing fixtures cannot prove compatibility with every future harness release.

Team accounts, permissions, shared replicas, cross-machine synchronization, and remote handoffs are not implemented. Native resume behavior varies by harness and should not be described as universal fork fidelity. Report generation may retrieve updated pricing data.

## Removed capabilities

Ollama integration, session-start hooks, all seven bundled skills, and their four MCP prompts have been removed. Installation cleans up only the retired Pacifico hook and skill links. The five MCP tools preserve session retrieval and memory access, as documented in [MCP-CURATION.md](MCP-CURATION.md).
