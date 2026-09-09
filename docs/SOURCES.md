# Native sources

Pacifico reads existing harness files and databases. It stores durable copies and builds a local SQLite search index. It does not create memories or write into harness data.

| Harness     | Conversations                                                                                                | Documents                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Claude Code | Project JSONL, including separate subagent transcripts                                                       | Project memory Markdown, CLAUDE.md and Claude rules                       |
| Codex       | Active and archived JSONL rollouts, including Zstandard-compressed files                                     | Memory Markdown, AGENTS.md and AGENTS.override.md                         |
| Cursor      | CLI SQLite blob stores, agent JSONL, IDE composers, workspace ItemTable composers and legacy chat containers | Cursor rules, classified as instructions                                  |
| Antigravity | SQLite steps, clean/full transcripts and native Git snapshots                                                | Knowledge Markdown, brain artifacts, asynchronous task logs and GEMINI.md |
| OpenCode    | SQLite and historical JSON sessions, messages and parts                                                      | AGENTS.md                                                                 |

## Configured memory locations

Claude memories follow `SESSIONS_CLAUDE_DIR` (the projects directory). Codex memories follow the home containing `SESSIONS_CODEX_DIR` (the sessions directory). Setting `SESSIONS_NATIVE_HOME` explicitly instead selects the standard document paths beneath that home. These settings affect discovery; existing archived documents are retained when locations change.

## Preservation

Original fields remain available separately from searchable message text. Unknown Antigravity binary payloads are retained without guessing their meaning. Cursor capability tools and thinking records preserve their native fields. OpenCode captures its session, message and part rows in one SQLite transaction. Child sessions retain their native parent IDs and are independently archived. The parent search projection also captures child user text in that transaction, so rebuilding from the archive preserves parent recall.

Missing native sources do not remove archived copies. The index can be rebuilt from those copies. Native document archives validate content hashes and source identity. The daemon and on-demand refresh share the same import operation.

## Coverage limits

- Antigravity standalone legacy `.pb` conversations are not imported. Some SQLite tool payloads are preserved only as raw records. Native Git transcript snapshots require `git` on the machine; Pacifico reads committed blobs without checkout or changes to the native repository.
- Cursor conversations represented in multiple native stores can appear separately. Historical Cursor memory storage has not been verified; rules are not labeled as memories.
- OpenCode JSON storage is read beside the configured database at `storage/session`, `storage/message` and `storage/part`. JSON and SQLite copies are preserved separately when both exist. Unknown part types remain in raw records.
- Project instructions are discovered at indexed working directories; nested instruction scopes are not recursively inferred.
- Codex diagnostic logs and external title-index files are not session sources. Mixed legacy event formats can require further reconciliation.

These limits concern format coverage. They do not mean the corresponding harness is unsupported. For query modes and raw-record pagination, see [MCP](MCP.md). For module boundaries, see [architecture](ARCHITECTURE.md).
