# Data available from agent sessions

This map describes the current adapters and a format sample inspected on September 5, 2026. Sampling the first MiB of two Claude and two Codex files establishes that certain fields exist; it does not establish complete coverage across every transcript. No private conversation content is reproduced here.

## Recorded and derived data

| Category                | Available when recorded by the harness                                | Current coverage                                                    |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Conversation            | Messages, roles, timestamps, titles, tools, and results               | Search and reading; some results are summarized or bounded          |
| Identity                | Session/turn/message IDs, parent-child relationships, harness version | Unified sessions; not every identifier has a public API             |
| Project                 | Working directory, repository, branch, worktrees, files               | Project/file filters and Git correlation through `why`              |
| Execution               | Tool names, arguments, commands, patches, output, errors              | File/command/error extraction; an invocation does not prove success |
| Model                   | Provider, model, changes, effort, mode, context                       | Usage reports; execution settings are only partly normalized        |
| Consumption             | Input/output tokens, cache usage, sometimes reasoning tokens          | Format-specific reporting and deduplication                         |
| Time                    | Start/end, duration, first token, pauses, interventions               | Aggregate activity; detailed latency analysis is not uniform        |
| Delegation              | Subagents, types, parents, usage, branches, forks                     | More detail for Claude and Pi; no universal parity                  |
| Customization           | Skills, plugins, MCP calls, hooks                                     | Present in some sources; no unified attribution view                |
| Context and permissions | Recorded instructions, sandbox, approval policy, compaction           | Preserved when present; partial normalization                       |

## Harness differences

**Claude Code:** JSONL and subagent files. Dispatch metadata helps attribute agent types and avoid counting copied responses twice after resume/fork. The sample contained `gitBranch`, `parentUuid`, `permissionMode`, `promptSource`, `effort`, `attributionSkill`, `attributionPlugin`, `attributionMcpServer`, and `attributionMcpTool`, plus some compaction and hook metadata. A present key does not guarantee a useful value in every session.

**Codex:** Multiple event and response-item formats. Sampled fields included `cli_version`, `context_window`, `source`, `thread_source`, `effort`, `sandbox_policy`, `approval_policy`, `permission_profile`, `workspace_roots`, `duration_ms`, and `time_to_first_token_ms`. Several remain candidates for expanded normalization. The current thinking extractor returns no Codex thinking content; encrypted or unrecorded reasoning cannot be recovered.

**Pi:** Tree and branch reconstruction. Usage parsing accounts for model changes, compaction, and branch summaries. Some subagent usage can be attributed to a parent without a detailed agent type/name.

**OpenCode:** Read-only SQLite access reconstructs sessions, messages, and parts. Tools, states, models, providers, tokens, and recorded cost can be extracted. The durable copy is normalized JSONL rather than an original provider JSONL file.

Other harnesses require their own adapters. Sharing a model provider does not imply sharing a storage format.

## Usage-format caveat

The sampled Codex files contained `token_usage_record` alongside the `event_msg` / `token_count` / `last_token_usage` format used by the existing report parser. Both samples contained corresponding counts of the two formats (12/12 and 10/10 in the sampled prefixes). They must not be summed as independent consumption. Expanded coverage requires identifying the authoritative record and deduplicating by response/turn IDs.

## Possible extensions

Source-linked decision summaries, contextual continuation, file-to-session mapping, repeated-error analysis, tool attribution, project budgets, and context-change histories can be built from this evidence. Decisions, blockers, summaries, and causes are interpretations rather than raw fields; they should retain provenance.

Elapsed time is not human working time. Estimated cost is not a subscription invoice. A test reported as passing in an old conversation does not establish the current repository state.

## Implementation references

- `packages/core/src/types.ts`: retrieval, context, and activity projections.
- `parser.ts` and `extract-*`: messages, files, commands, and errors.
- `report/parsers/`: harness-specific usage normalization.
- `pi-tree.ts`: Pi branches and forks.
- `opencode.ts`: SQLite reconstruction.
- `why/correlate.ts`: Git correlation and evidence levels.
