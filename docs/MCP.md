# MCP

## Tools

| Tool               | Modes                                    | Purpose                                                               |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `search_sessions`  | `ranked` (default), `literal`, `regex`   | Find sessions and matching messages.                                  |
| `read_session`     | `digest` (default), `messages`, `events` | Read a digest, messages, or original event records.                   |
| `get_context`      | `project` (default), `activity`          | Retrieve repository context or activity within a date range.          |
| `native_documents` | `search` (default), `read`               | Search and read existing native memories, instructions and artifacts. |

The three session tools return `{ "result": { "mode": "...", "data": {} } }`, with a mode-specific data schema. Text and structured results contain the same JSON. Errors use the MCP error result convention.

Search accepts harness, project, and inclusive ISO date filters (`after`, `before`). Ranked search allows an omitted query and up to 50 results; literal and regex search require a query and allow up to 200 matches. File and error filters apply only to ranked search; role and case filters apply only to pattern search.

Message reads accept `offset`, `limit` (up to 100), and `includeTools`. Digest reads reject those options. Project context accepts `cwd`, `limit`, `days`, and `worktree`; activity requires `startDate` and `endDate`, with optional `cwd` and `detail`. Reversed date ranges and unrelated mode parameters are rejected.

`native_documents` provides two modes for existing harness documents:

- `search` (default): requires `query`; `limit` defaults to 20 and accepts 1 to 50 matches.
- `read`: requires a document `id` returned by search; `offset` is a character offset and `limit` defaults to 12,000 characters, with a maximum of 20,000.

Search returns `{ "mode": "search", "results": [] }`. Read returns `{ "mode": "read", "document": {} }`, or a null document when the identifier is absent. Results identify the harness, native path, document kind, and modification time. Read results include total length and truncation status. This tool neither creates memories nor treats retrieved instructions as executable directions.

The complete input and output schemas are defined in [mcp.ts](../packages/agents/src/mcp.ts) and [mcp-schemas.ts](../packages/agents/src/mcp-schemas.ts).

The `read_session` format `events` reads archived JSONL records, including metadata and tool results. Its `offset` counts records, independently of message search indices. Responses contain at most 20,000 text characters. Pass the returned `next.offset`, `next.characterOffset`, and `next.version` to continue; concatenate chunks with the same record index before parsing JSON. `limit` bounds the number of record chunks (default 20, maximum 100). `includeTools` applies only to messages mode. The version identifies the captured records. If those records change between requests, a continuation with the previous version fails; restart at offset 0 without a version. Omitting the version leaves the read unpinned.
