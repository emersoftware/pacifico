# Archive retention

Pacifico keeps useful history without storing a second complete execution log.
This policy runs by default on every import. Native agent files are never modified.

## Retained information

- User and assistant messages, in order, with stable search message indices.
- Tool calls, complete arguments, results and error content.
- Session identity, project, title, branch, timestamps and subagent identity.
- Attachments present in retained messages.
- Unclassified native records and parts, because unknown content is not proof of disposable metadata.

Known internal records are removed: configuration snapshots, repeated accounting
counters, queue/progress bookkeeping, native database row copies already represented
by messages, and reasoning blocks. This is deterministic compaction, not an LLM summary.

Before dropping accounting metadata, Pacifico stores a `pacifico_summary` record:

- Disjoint input, output, cache-read and cache-write token totals. Reasoning tokens
  already included in output are not added again. One-hour cache writes remain a
  subset of total cache writes.
- Source-reported cost and estimated cost in separate fields. Estimates use the
  embedded pricing table at compaction time; unpriced models are listed explicitly.
- Elapsed session time, separately from explicitly recorded execution duration.
  Missing durations are null, not fabricated work time.
- Source hash, source byte/record counts, discarded record count and unclassified count.
- Minimal usage receipts used to deduplicate API responses across session copies
  and retain daily/model breakdowns after native files disappear.

Accounting adapters cover Claude Code, Codex (including per-response receipts) and
OpenCode. Unsupported or absent accounting is marked `usageKnown: false`. The
presence of a zero total does not prove zero usage. Repeated cumulative counters and
repeated response identifiers are deduplicated before aggregation.

Compaction checks that searchable messages and tool summaries remain identical.
Malformed or incompatible transcripts are retained losslessly inside compressed
objects instead of being partially stripped.

## Storage and automatic maintenance

Objects live under `archive/objects/<content-sha256>.jsonl.gz`. Identical snapshots
share one object while their original paths remain independently addressable in
`manifest.json`. Portable gzip is decoded by session retrieval, index rebuilds and
remote upload. Small accounting sidecars avoid decompressing transcripts for reports.

The manifest is committed after the new object passes decompression verification.
Replaced managed objects are collected after a 60-second reader grace period. Legacy
copies are removed only after no manifest entry references them. Unknown legacy
orphans remain untouched. An invalid manifest aborts maintenance rather than treating
the archive as empty. A failed or interrupted migration can be retried.

Representation-only migrations preserve the index change signal, avoiding a full
reindex of sessions whose conversation did not change.

Every refresh also migrates up to four legacy entries. The background service and MCP
imports use the same policy and refresh lock. Maintenance does not require a separate
cron job. The archive still grows with new conversation content; this policy removes
avoidable duplication and metadata, not useful historical messages.

## Commands

```sh
pacifico vault compact          # Preview the number of legacy entries
pacifico vault compact --apply  # Finish migration, yielding between sessions
pacifico vault status           # Count shared objects only once
pacifico vault inspect SESSION  # Include the accounting summary when available
```

Upgrade all processes reading the shared archive before applying migration. Older
executables do not decode gzip objects. Existing native sources remain unchanged,
but a compacted archive is intentionally not a byte-for-byte native backup.

Remote uploads carry the retained JSONL and accounting summary, not gzip bytes.
Remote immutable versions already uploaded are outside local garbage collection.
