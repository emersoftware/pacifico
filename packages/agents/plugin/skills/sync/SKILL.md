---
name: sync
description: Synchronize skills and MCP configuration between Claude Code, Codex, Cursor, Antigravity, and OpenCode using Pacifico. Use when a capability is missing in another harness or the user asks to copy agent configuration. Not for session or server synchronization.
---

# Sync skills and MCP

Use `pacifico sync` through the host's terminal tool. Pacifico has no MCP tool for
configuration sync. The source is authoritative for the selected items; this is
one-way copying, not a background or bidirectional merge.

## Workflow

1. Determine the source harness, destinations, and requested capabilities. Supported
   CLI names are `claude`, `codex`, `cursor`, `antigravity`, and `opencode`.
   Infer these from the request; ask only when the direction or scope is missing.
   Global configuration is the default. Use `--project /absolute/path` for a
   project-scoped request. Do not expand one named skill into a full configuration copy.
2. Run a preview without `--apply`. Inspect the JSON item statuses and destinations.
   Preview output omits configuration values; do not print raw files or credentials.
3. If the user asked to synchronize or install the selected capabilities, that
   authorizes applying that scope after inspecting the preview. Run the same
   command with `--apply`; do not ask for confirmation again. A request to inspect,
   compare, or preview does not authorize applying.
4. Treat `conflict` as a destination change to preserve. Do not delete files or
   edit the sync manifest to bypass it. Explain the affected items and obtain the
   user's choice before replacing their changes. `unsupported` means the selected
   configuration cannot be translated; do not guess an equivalent or strip options.
5. Read the apply result, then repeat the preview to verify the copied items are
   `unchanged`. Report what copied, what did not, and any backup path returned.
   Config verification does not prove the destination harness loaded the capability;
   reload it and check discovery when available, otherwise state that limitation.

The engine copies whole skill folders and translates supported MCP configuration.
It backs up changes and refuses conflicts. An apply can copy supported items while
reporting unsupported ones; a nonzero exit does not prove nothing changed.
Source deletion does not delete destination capabilities.

## Examples

"Copy the adr skill from Codex to Claude Code and Cursor."

```sh
pacifico sync --from codex --to claude,cursor --kind skills --name adr
pacifico sync --from codex --to claude,cursor --kind skills --name adr --apply
pacifico sync --from codex --to claude,cursor --kind skills --name adr
```

"Show which MCP servers would copy from Claude Code to OpenCode."
Run only the preview:

```sh
pacifico sync --from claude --to opencode --kind mcp
```

"Sync this project's Pacifico MCP configuration to Antigravity."
Use the actual project path and source harness from the request:

```sh
pacifico sync --from codex --to antigravity --project /work/app --kind mcp --name pacifico
pacifico sync --from codex --to antigravity --project /work/app --kind mcp --name pacifico --apply
```

Repeat `--name` to select multiple items. Omit `--kind` only when both skills and
MCP configuration are requested.

## Skills and MCP shipped in plugins

If a skill is supplied by a plugin, it may not be in the harness's direct skills
folder. Select the known installed plugin directory explicitly; do not copy every
cached plugin version. A missing direct destination folder does not prove the
capability is unavailable through an already active destination plugin.

```sh
pacifico sync --from codex --to claude --kind skills --skills-dir /path/to/plugin/skills --name adr
pacifico sync --from codex --to claude --kind skills --skills-dir /path/to/plugin/skills --name adr --apply
```

For a plugin's standard `mcpServers` configuration, `--from claude` selects that
file format even if the plugin was discovered in another harness:

```sh
pacifico sync --from claude --to codex --kind mcp --config-file /path/to/plugin/.mcp.json --name pacifico
pacifico sync --from claude --to codex --kind mcp --config-file /path/to/plugin/.mcp.json --name pacifico --apply
```

These commands copy the selected capabilities, not plugin installation or
activation. Do not copy OAuth credential stores; authentication happens in each
harness. Explicit environment and header values in selected MCP configuration can
contain credentials and are copied locally. Never repeat those values in output.
Unsupported interpolation or client-specific options require an explicit compatible
configuration, not silent removal.
