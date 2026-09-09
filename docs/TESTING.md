# Testing

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run check:architecture
bun test
bun run build
bun run test:binary
bun run site:build
bun run site:check
```

`site:build` installs the website dependencies from its lockfile before building.

Tests use synthetic transcripts and isolated configuration. Never point installer tests at real client settings. `test:binary` checks installation, MCP discovery, search, archive recovery, and uninstall against temporary data. `test:launchd` additionally verifies a temporary macOS service and removes it afterwards.

`bun run eval` checks search ranking against the fixed corpus in [the eval directory](../packages/core/src/eval). Update expected results only when the intended ranking behavior changes. The default test run skips the opt-in real-corpus checks.

## Local history checks

Run the Claude and Codex corpus checks separately:

```sh
SESSIONS_LIVE_CORPUS=1 bun test --timeout 120000 packages/core/src/parser.corpus.test.ts
```

These checks read native transcripts from the current user's home directory. They validate message extraction, user/context classification and dense message numbering. They do not install integrations, refresh Pacifico's index or write into the harness directories. A large history takes longer than Bun's default five-second test timeout. Missing native roots do not establish format coverage.

The synthetic source-import tests cover Cursor CLI/IDE and Antigravity database/companion formats, deleted-source retrieval and index reconstruction. Native-document tests cover memory/instruction classification, asynchronous task logs, project instructions and archive recovery. The concurrent-source test changes a fixture between reading and verification, then checks that the old index/archive survive until a stable retry. These tests complement real-history checks; neither alone establishes support for every historical format.
