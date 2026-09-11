# Pacifico examples

Example request: "Recover the ADR explaining why this repository uses SQLite.
Show the evidence; do not save it."

Replace example paths, dates, indices, and quotes with actual search results.
The JSON below contains MCP arguments; call the tool named above each block.

## Find existing records and original exchanges

`get_context`:

```json
{ "mode": "decisions", "scope": "local", "cwd": "/work/pacifico", "query": "SQLite", "limit": 10 }
```

`search_sessions`:

```json
{
  "mode": "ranked",
  "scope": "local",
  "project": "/work/pacifico",
  "query": "SQLite",
  "after": "2026-09-01",
  "before": "2026-09-10",
  "limit": 10
}
```

Repeat with alternatives such as PostgreSQL or FTS5 and expand dates when needed.
Do not impose the example date range on another project.

`read_session`, using the exact returned `filePath` and an offset around a hit:

```json
{ "format": "messages", "scope": "local", "filePath": "/archive/session.jsonl", "offset": 10, "limit": 6 }
```

Read additional pages when acceptance, a correction, or a complete quote lies
outside the current response. A search snippet is not sufficient evidence.
For saved-record pagination, follow `nextOffset`; a truncated record can be read
in full through `pacifico decisions list`.

Equivalent CLI workflow:

```sh
cd /work/pacifico
pacifico decisions list --project /work/pacifico --query SQLite
pacifico why "SQLite" --json
pacifico digest SESSION_ID
pacifico read SESSION_ID --json --offset 10 --limit 6
```

`digest` is an overview. `read` supplies the zero-based message indices used in
citations; these are not raw JSONL line numbers or digest exchange numbers.

Return a document shaped like this, replacing the illustrative content with findings:

```markdown
# Use SQLite for the local index

Status: Accepted
Date: 2026-09-10

## Context

The project needs local text search without operating a database service.

## Decision

Use SQLite with FTS5 for the local index.

## Consequences

The index can run on the user's machine. Cross-device synchronization remains
separate work. State which consequences were discussed and which are analysis.

## Evidence

- Session SESSION_ID, user message 12: "Yes, use SQLite with FTS5."
```

Use Proposed if no acceptance is found. Do not save that proposal as accepted.

## Save only when requested

Example request: "Save this accepted ADR in Pacifico."

Use the host's file-writing tool to create a temporary JSON file containing the
verified record. The current API has `rationale`, not separate `context` and
`consequences` fields; retain both sections there:

```json
{
  "project": "/work/pacifico",
  "title": "Use SQLite for the local index",
  "decision": "Use SQLite with FTS5 for the local index.",
  "rationale": "## Context\n\nLocal text search should not require a database service.\n\n## Consequences\n\nThe index runs locally. Cross-device synchronization remains separate work.",
  "decidedAt": "2026-09-10",
  "evidence": [
    {
      "filePath": "/archive/session.jsonl",
      "messageIndex": 12,
      "quote": "Yes, use SQLite with FTS5."
    }
  ]
}
```

```sh
pacifico decisions save --file /tmp/adr.json
pacifico decisions list --project /work/pacifico --query SQLite
```

Include real user acceptance and adjacent context where needed (up to eight
citations). Never run this fabricated example as a real save. If the decision date
is unknown, resolve it before saving because the store requires a date.
For a replacement, add `"supersedes": "PREVIOUS_RECORD_ID"` using an actual saved
ID. Exact repeated records are idempotent; consult existing records to avoid
paraphrased duplicates. Remove the temporary file when done.

## Export or write Markdown

Example request: "Export the saved records for this project to /work/pacifico/docs/adr."

```sh
pacifico decisions export --project /work/pacifico --out /work/pacifico/docs/adr
```

This exports all saved project records with evidence, IDs, and a Rationale section
containing Context and Consequences. It refuses existing filenames. For one ADR,
or an ADR that should never enter SQLite, write the document directly with the
host's file tools. Do not export all records when the user requested only one.
