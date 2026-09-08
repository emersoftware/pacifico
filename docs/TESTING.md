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
bun run site:check
bun run site:build
```

Install the website dependencies with `bun install --frozen-lockfile` from `apps/site` before its first check.

Tests use synthetic transcripts and isolated configuration. Never point installer tests at real client settings. `test:binary` checks installation, MCP discovery, search, archive recovery, and uninstall against temporary data. `test:launchd` additionally verifies a temporary macOS service and removes it afterwards.

`bun run eval` checks search ranking against the fixed corpus in `packages/core/src/eval`. Update expected results only when the intended ranking behavior changes. Optional real-corpus tests may be skipped when their fixtures are unavailable.
