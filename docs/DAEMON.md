# Background indexing

The optional service keeps the archive and index up to date without an active MCP query. On macOS it runs as a user LaunchAgent, without sudo.

```sh
pacifico daemon start
pacifico daemon status
pacifico daemon stop
```

`pacifico daemon run` performs one import and exits; it also works on Linux. Automatic service registration is available only on macOS. Configuring MCP and enabling the daemon are separate operations.

## Scheduling

The LaunchAgent runs once when registered, then every 30 seconds when launchd schedules it. It works while the user is logged in. A run still in progress prevents overlapping scheduled workers; missed intervals do not accumulate a queue. Sleep and system scheduling can delay imports.

This is incremental importing, not instant capture. A native transcript removed before its first import cannot be recovered. Large initial imports can take longer than the normal interval.

The service definition lives at `~/Library/LaunchAgents/com.emersoftware.pacifico.plist`. Homebrew installations use the stable `opt` executable path. If a standalone executable moves, run `daemon start` again from its new location.

The last result is stored at `~/.local/share/pacifico/daemon-state.json`: completion time, duration, counts, and an error when applicable. There is no continuously growing log file.

## Configuration

Known source and data environment overrides are saved in the plist. Relative paths become absolute. The entire shell environment is not copied. Run `start` again to change registered overrides.

The source overrides are:

| Variable                      | Default source                                                    |
| ----------------------------- | ----------------------------------------------------------------- |
| `SESSIONS_CLAUDE_DIR`         | `~/.claude/projects`                                              |
| `SESSIONS_CODEX_DIR`          | `~/.codex/sessions`                                               |
| `SESSIONS_CODEX_ARCHIVED_DIR` | `archived_sessions` beside the Codex sessions directory           |
| `SESSIONS_CURSOR_DIR`         | `~/.cursor`                                                       |
| `SESSIONS_CURSOR_IDE_DIR`     | `~/Library/Application Support/Cursor/User`                       |
| `SESSIONS_ANTIGRAVITY_DIR`    | `~/.gemini`                                                       |
| `SESSIONS_OPENCODE_DB`        | `~/.local/share/opencode/opencode.db`                             |
| `SESSIONS_NATIVE_HOME`        | Home directory used to find native memories, rules, and artifacts |

`SESSIONS_HOME` changes Pacifico's default home directory. When `SESSIONS_CURSOR_DIR` is set without `SESSIONS_CURSOR_IDE_DIR`, IDE discovery uses its `User` subdirectory. Document discovery uses its own home override and does not inherit individual session-directory overrides.

## Concurrency and retention

MCP and background workers share a SQLite refresh lock stored separately from the rebuildable index. It protects the full manifest update across processes and is released automatically if its owner exits. A competing process waits for up to 60 seconds before reporting failure.

Transcripts are copied to temporary files and published by rename. An interrupted write preserves the previous complete copy. The archive retains the latest snapshot, not an unlimited version history.

`stop` removes the scheduled job and its plist. `uninstall` also stops it. Both preserve the archive. Managed-service operations refuse to replace or delete an unrelated plist without Pacifico's ownership marker.

## Checks

Coverage includes concurrent workers, lock-owner termination, XML escaping, environment isolation, archive reconstruction after source removal, and native launchd bootstrap/update/bootout using temporary sources and a unique label. The launchd smoke test allows 45 seconds for cold startup and system scheduling.

When a [remote server](SERVER.md) is configured, each pass uploads new or changed archive snapshots after local import. Server failures are recorded as failed runs and retried on the next pass; local indexing has already completed. `daemon status` includes upload counts on a successful run.
