# MCP curation

## Evidence and current state

This inventory was checked against Pacifico's registrations in `packages/agents/src/mcp.ts`, Mosaic 0.2.24's local `--help`, and the installed Mosaic skill and its four reference guides. It describes that installed Mosaic workflow, not every historical Mosaic release.

| Surface                | Pacifico 0.1.1                   | Pacifico current source | Installed Mosaic workflow                     |
| ---------------------- | -------------------------------- | ----------------------- | --------------------------------------------- |
| MCP tools              | 12                               | 5                       | None exposed by this CLI/skill workflow       |
| MCP prompts            | 4                                | 0                       | None exposed                                  |
| Bundled skills         | 7                                | 0                       | 1 routing skill                               |
| Skill reference guides | —                                | —                       | 4: finding, forking, handoffs, recovery       |
| Harness readers        | Claude Code, Codex, Pi, OpenCode | Same four               | 15 provider IDs documented in the local skill |

Mosaic's documented providers are Claude Code, Cursor, OpenCode, Codex, Pi, Amp, GitHub Copilot, Cline, OpenClaw, Hermes, Droid, Grok, Kimi Code, Antigravity, and Devin. Documented support is not a claim that all have been tested here. Devin is browse-only in that workflow.

Mosaic does not offer twelve equivalent MCP tools to merge with ours. Its agent guidance searches a compact `SessionIndex` catalog, reads a bounded set of referenced native artifacts, and uses CLI commands for continuation and service management. Pacifico can adopt that retrieval sequence without depending on Mosaic's installation, shared storage, authentication, or team accounts.

## Five-tool contract

| Tool              | Modes                                                  | Purpose                                                                          |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `search_sessions` | `ranked` (default), `literal`, `regex`                 | Find sessions and matching messages.                                             |
| `read_session`    | `digest` (default), `messages`, selected with `format` | Read a compact digest or a paginated message range.                              |
| `get_context`     | `project` (default), `activity`                        | Retrieve repository context or activity within a date range.                     |
| `get_memory`      | No mode                                                | Retrieve approved memory by repository and optional topic.                       |
| `review_memory`   | `sources` (default), `entries`, `recurrence`           | Inspect native memory sources, preview entries, or compare recurring statements. |

The four merged tools return `{ "result": { "mode": "...", "data": {} } }`, with a mode-specific data schema. `get_memory` retains its existing payload. Text and structured results contain the same JSON. Errors use the MCP error result convention.

Search accepts harness, project, and inclusive ISO date filters (`after`, `before`). Ranked search allows an omitted query and up to 50 results; literal and regex search require a query and allow up to 200 matches. File and error filters apply only to ranked search; role and case filters apply only to pattern search.

Message reads accept `offset`, `limit` (up to 100), and `includeTools`. Digest reads reject those options. Project context accepts `cwd`, `limit`, `days`, and `worktree`; activity requires `startDate` and `endDate`, with optional `cwd` and `detail`. Reversed date ranges and unrelated mode parameters are rejected.

Memory review accepts `cwd`. Entry review additionally accepts `agent` and `topic`; recurrence review accepts `all`. Approval, rejection, import, and other memory writes remain explicit CLI operations. Existing memory decisions and transcript archives are preserved.

## Migration from twelve tools

| Previous tool           | Replacement                                           |
| ----------------------- | ----------------------------------------------------- |
| `search_sessions`       | `search_sessions`, ranked mode, new response envelope |
| `grep_sessions`         | `search_sessions`, literal or regex mode              |
| `get_session_messages`  | `read_session`, messages format                       |
| `get_session_digest`    | `read_session`, digest format                         |
| `get_activity_digest`   | `get_context`, activity mode                          |
| `get_context_primer`    | `get_context`, project mode                           |
| `get_memory`            | Unchanged                                             |
| `get_memory_sources`    | `review_memory`, sources mode                         |
| `review_agent_memories` | `review_memory`, entries mode                         |
| `get_memory_recurrence` | `review_memory`, recurrence mode                      |
| `why_did_this_change`   | Removed from MCP; CLI correlation remains available   |
| `get_session_metrics`   | Removed from MCP; CLI reports remain available        |

No compatibility tool aliases are registered. Clients must reload tool discovery after upgrading and adapt calls to the new schemas.

Keeping twelve tools would retain narrowly scoped calls but repeat search, read, context, and memory review concepts. Five tools consolidate those tasks while preserving explicit modes and validated payloads. Session resources remain available separately from tools.

The retrieval sequence is: discover candidates, read relevant fragments, and cite the session. Native agent stores remain read-only. The daemon remains a CLI service. This change does not add Mosaic team synchronization, handoffs, or remote continuation.

## Completed removal

- Ollama probing, embeddings, vector ranking, and daemon environment forwarding.
- Session-start hook installation and execution.
- The seven skills: context, memory, recall, session-metrics, standup, weekly-summary, and why.
- The four MCP prompts backed by those skills.

A compatibility cleanup removes only the exact retired Pacifico hook and links into Pacifico's old plugin skills directory. Existing transcript archives and memory decisions are preserved. The remaining inherited reports, memory, Wrapped, and correlation implementations have not been removed in this pass, and the core is still derived from sessions. An independently implemented core remains separate work.
