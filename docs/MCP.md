# MCP

## Three-tool contract

| Tool              | Modes                                                  | Purpose                                                      |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `search_sessions` | `ranked` (default), `literal`, `regex`                 | Find sessions and matching messages.                         |
| `read_session`    | `digest` (default), `messages`, selected with `format` | Read a compact digest or a paginated message range.          |
| `get_context`     | `project` (default), `activity`                        | Retrieve repository context or activity within a date range. |

All three tools return `{ "result": { "mode": "...", "data": {} } }`, with a mode-specific data schema. Text and structured results contain the same JSON. Errors use the MCP error result convention.

Search accepts harness, project, and inclusive ISO date filters (`after`, `before`). Ranked search allows an omitted query and up to 50 results; literal and regex search require a query and allow up to 200 matches. File and error filters apply only to ranked search; role and case filters apply only to pattern search.

Message reads accept `offset`, `limit` (up to 100), and `includeTools`. Digest reads reject those options. Project context accepts `cwd`, `limit`, `days`, and `worktree`; activity requires `startDate` and `endDate`, with optional `cwd` and `detail`. Reversed date ranges and unrelated mode parameters are rejected.

The complete input and output schemas are defined in [mcp.ts](../packages/agents/src/mcp.ts) and [mcp-schemas.ts](../packages/agents/src/mcp-schemas.ts).
