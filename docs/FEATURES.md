# Decisions, configuration sync, and usage

## Project decisions

The bundled `adr` skill uses existing session search and reading to
recover Architecture Decision Records without saving them by default. ADRs include
context, decision, consequences, status, date, and source evidence. Proposed ADRs
can be returned in the conversation; the current store accepts only accepted decisions. Only an explicit
request to save invokes `decisions save`, which validates exact source quotes
and stores the result in durable `decisions.sqlite`, separate from the disposable
search index. The database is created on the first save, not when listing decisions. Each record needs
at least one user-message citation from the same project. Quote validation proves
provenance, not that the user's words semantically approve the interpretation.

```sh
pacifico decisions list --project /path/to/repository
pacifico decisions list --project /path/to/repository --query database
pacifico decisions save --file /tmp/decision.json
pacifico decisions export --project /path/to/repository --out /chosen/adr-folder
```

The [skill](../packages/agents/plugin/skills/adr/SKILL.md) documents the
MCP and CLI examples, including the save format. Context and Consequences are
preserved in the stored `rationale` field. Markdown-only requests can be written
directly without a SQLite save. `pacifico read SESSION --json --offset 10 --limit 5` provides numbered
messages for citations. Message numbers match the MCP messages view. Identical
records are idempotent. A later decision can name an earlier ID in `supersedes`;
both records remain available. Export requires an explicit folder and refuses to
overwrite existing files. To refresh an export after a decision changes, choose
a new folder or deliberately remove the old exported file yourself.

MCP retains four tools. `get_context` accepts `mode: "decisions"`, `cwd`, `query`,
`limit`, and `offset`. This mode is local; use `scope: "local"`. Saving and Markdown
export use the CLI. Server synchronization of decisions is not included. Native
documents and generated decision records remain separate.

MCP returns bounded summaries with `truncated` flags and `nextOffset` pagination.
The CLI returns the full stored records.

`pacifico install` bundles the skill with the Claude plugin and links it for
detected Codex, Cursor, Antigravity, and OpenCode installations. An existing skill
with the same destination name is left intact.

## Skills and MCP configuration

The bundled `sync` skill uses the CLI to preview, apply, and verify synchronization
within the requested scope. It includes examples for named skills, MCP servers,
project configuration, and plugin sources.

```sh
pacifico sync --from claude --to codex,cursor,antigravity,opencode
pacifico sync --from codex --to claude --kind skills --name my-skill
pacifico sync --from claude --to codex --project /path/to/repository
pacifico sync --from claude --to codex,cursor --apply
```

The default is a read-only preview of global configuration. `--project` selects
project configuration instead. `--kind skills|mcp` and repeatable `--name` narrow
the scope. The source is explicit; this is not an automatic multi-master daemon.

For skills shipped inside a local plugin, select its skill directory explicitly:

```sh
pacifico sync --from codex --to claude,cursor --kind skills --skills-dir /path/to/plugin/skills
```

`--config-file /path/to/.mcp.json --kind mcp --from claude` similarly reads a
standard `mcpServers` file from a plugin. The `--from` harness determines its
configuration format. These options copy the selected portable capabilities;
they do not install or enable the source plugin in the destination application.

Skills include their supporting files. MCP commands, arguments, environment
values, working directories, and HTTP headers are translated to each client's
format. Preview output contains item names and statuses, not credential values.
Credentials explicitly present in a selected MCP definition remain in the local
destination configuration; OAuth login stores are never copied.

| Harness     | Global MCP                                          | Project MCP               |
| ----------- | --------------------------------------------------- | ------------------------- |
| Claude Code | `~/.claude.json`                                    | `.mcp.json`               |
| Codex       | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `.codex/config.toml`      |
| Cursor      | `~/.cursor/mcp.json`                                | `.cursor/mcp.json`        |
| Antigravity | `~/.gemini/config/mcp_config.json`                  | `.agents/mcp_config.json` |
| OpenCode    | `$XDG_CONFIG_HOME/opencode/opencode.json[c]`        | `opencode.json[c]`        |

Existing legacy Antigravity profiles at
`~/.gemini/antigravity/mcp_config.json` are supported when the newer location is
absent. Direct skill directories and legacy skill locations are read; provider
plugin registries, bundled app connectors, and plugin enablement are not copied.
Restart or reload the destination harness if it does not notice configuration
changes automatically.

Application preserves unrelated configuration and JSONC/TOML comments. Pacifico
tracks the last content it wrote. A destination edit or an unowned conflicting
item blocks application. Unsupported per-harness options, interpolation, and
external links inside skills are reported instead of silently dropped. No items
are deleted because they disappeared from the source. Backups and their path map
live in Pacifico's data directory under `backups/config-sync`.

## Recorded token usage

```sh
pacifico usage
pacifico usage --json
pacifico usage --cached --group model --period 7d
pacifico usage --project /path/to/repository --group task
pacifico usage --harness codex --model MODEL --timezone America/Santiago
```

The terminal summary includes today, the last 7, 30 and 365 calendar days, all
recorded history, and current/longest active-day streaks. Windows include today
and use the selected timezone. A current streak may end yesterday. `B` means
1,000,000,000 tokens. These are measured token totals, not subscription limits,
remaining credits, or billed dollars.

Grouping supports `day`, `project`, `harness`, `model`, and `task`. A task currently
means a harness-native session, identified as `harness:sessionId`; arbitrary
cross-session task attribution is not inferred. Missing project information is
shown as unknown. Use `--task SESSION` to filter a particular session.

Claude Code, Codex, and OpenCode usage refresh from local sources. Codex includes
archived and Zstandard-compressed rollouts. Stable response identifiers remove
duplicates, repeated Codex cumulative counters are skipped, and input/output
totals include cache and reasoning only once. Parsed events are retained in
`usage.sqlite` so a later native-history deletion does not erase usage already
recorded by this command. `--cached` queries this database without rescanning.

Cursor and Antigravity need measured usage exports; their conversation text is
not used to estimate tokens:

```sh
pacifico usage import --harness cursor --file usage.json --project /path/to/repository
pacifico usage import --harness antigravity --file usage.jsonl
```

Cursor input uses `usageEventsDisplay` records with native `conversationId`,
timestamp, model, and `tokenUsage`. Antigravity input uses `session_meta` and
`usage` JSONL records, as inspected in tokscale's parser. This is not a claim that
all Antigravity transcript formats contain usage. No provider login or dashboard
scraping is performed. Reimporting the same export does not recount it. Missing
usage remains unknown; the JSON response reports source coverage explicitly.

### Terminal usage view

`pacifico usage` opens an interactive activity calendar in a terminal. Press `r`
to cycle all time, today, 7 days, 30 days, and 365 days; `Tab` switches between
overview and models, `Ctrl+S` copies the view, and `q` exits. `--plain` prints once;
pipes also receive plain text. `--json` returns data without terminal controls.

The calendar shows up to 53 weeks, reduced to fit the terminal. Statistics follow
the selected period; streaks remain all-time. Top model means most recorded tokens.
Session counts include sessions with recorded usage in that period. Session
duration is omitted because usage timestamps do not measure working time.
