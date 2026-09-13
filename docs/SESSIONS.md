# Start and send

Pacifico connects Claude Code and Codex sessions, including sessions opened
by another client through the official receiving interfaces. It uses the official installed executables and their existing login.
There is no review-specific command: a review, a question and an implementation
task are all messages.

```sh
pacifico start codex "Review the changes against main" --wait
pacifico start claude "Investigate the failing validation" --cwd /path/to/project --wait
pacifico sessions
pacifico send codex:<native-id> "Now focus on the tests" --wait
pacifico result <request-id> --json
pacifico sessions close codex:<native-id>
pacifico sessions stop
```

Use the complete session identifier returned by `start` or `sessions`. Short-ID
matching is not implemented. `start` accepts `--write` to allow file edits for
that new session. `send` retains the session's existing access. Externally connected sessions
report `write: null` because Pacifico did not select their permissions. Codex uses its
read-only or workspace-write sandbox and never auto-approves escalation. Claude
defaults to the Read/Grep/Glob built-in tools with external MCP configuration
excluded. `--write` selects its native acceptEdits mode. Claude tool selection is
not an OS sandbox; user-configured lifecycle hooks remain the harness's concern.
Neither adapter bypasses native permissions. Requests needing unavailable
approval may fail or be denied.

## Session identity and delivery

`start` creates a native conversation and sends the first message. Its official
harness process remains alive. `send` connects to the existing receiver and submits another message, preserving
its conversation and native identifier. It never creates a replacement or forks
the conversation. For external Codex sessions, it subscribes with `thread/resume`
on the same shared server after verifying that the session is already loaded.

The receipt contains `request`, `session`, `status`, and `text`. The initial
`running` status means the local host has accepted the work, not that the model
has completed it. `result` returns `completed`, `failed`, or `unknown` when the
outcome cannot be determined after a lost connection. Unknown delivery is never
automatically retried. Unreachable sessions reject new work. Codex requires an idle session; Claude
channels queue events in the native session and allow one outstanding Pacifico request.

`--wait` waits at most 60 seconds. A wait timeout does not cancel the request.
Read it later with `result`. Responses longer than 20,000 characters are returned
with `truncated: true`; the complete response remains in the local request store
and the harness's native transcript. No response text is synthesized from an
unrelated later transcript entry.

## Local host

The first command starts a local Pacifico session host. It owns the live harness
processes and a user-only Unix socket under `/tmp/pacifico-<uid>/`. Task receipts
and responses live in `~/.local/share/pacifico/control/requests.sqlite`, separate
from the rebuildable search index. This directory follows `SESSIONS_DATA_DIR`.
It contains no copied authentication tokens. Native authentication remains in
the harness. Closing a session disconnects its process but preserves its history.
Close and stop require idle sessions, so they do not abort active tasks.
Stopping the host closes its owned processes and disconnects external receivers
without killing their native application. On a later host start, unfinished
requests become unknown and no tasks are replayed.

The session host is independent of the archive daemon, which currently runs
periodic import jobs. Archive import and search do not require a session host.
The host runs until explicitly stopped; it is not installed as a login service.

## MCP

Session execution is opt-in because the default archive MCP is read-only.
Configure the local MCP command as:

```sh
pacifico --mcp --session-control
```

This adds `start_session`, `send_to_session`, `list_sessions`, and `read_request`
to the existing history tools. Start and send are mutating tools, require user
authorization, and return immediately with a request identifier. Use
`read_request` to retrieve the corresponding response. The self-hosted archive
server does not expose these execution tools.

## Official adapters

- Codex uses [`codex app-server`](https://learn.chatgpt.com/docs/app-server),
  its initialization handshake, `thread/start`, `turn/start` and turn/item
  notifications over stdio. App Server is experimental. Pacifico does not depend
  on private desktop pipes or a third-party reimplementation.
- Claude uses the official
  [programmatic CLI](https://code.claude.com/docs/en/headless) with persistent
  stream-json input/output. The executable owns the agent loop, model calls and
  native transcript. Pacifico associates each `result` with its single active
  request. Native session IDs are assigned using `--session-id`.

## Existing sessions outside Pacifico

### Codex

```sh
pacifico send codex:<native-id> "Continue using the existing context" --wait
pacifico send codex:<native-id> "Continue" --socket /path/to/app-server.sock --wait
```

The default connects to `$CODEX_HOME/app-server-control/app-server-control.sock`
using the official WebSocket-over-Unix protocol. `CODEX_HOME` defaults to `~/.codex`.
`--socket` selects the receiving App Server explicitly; MCP accepts the same
optional `socket` argument. Pacifico verifies loaded membership, subscribes to
that existing session, and checks idle state before submitting. It correlates
responses by thread and turn IDs, so another client's turn cannot complete a
Pacifico request. Concurrent native clients can still race between status check
and submission; the server decides whether the turn can start. Closing only
closes Pacifico's client connection, not the receiving server.

A standalone terminal process without an exposed App Server transport is not
reachable by this mechanism. Pacifico does not use UI automation or spawn a
replacement process over its transcript.

### Claude Code

Register the receiver as an MCP server inside the project of the native session.
Use the native session ID shown by Claude's `/status`:

```sh
claude mcp add --transport stdio pacifico-channel -- pacifico channel <native-id>
claude --resume <native-id> --dangerously-load-development-channels server:pacifico-channel
```

The second command is the official opt-in for a custom channel during Anthropic's
research preview. If the session is already running without this opt-in, exit
that terminal session and resume that same ID with the flag; do not run competing
processes against its transcript. No new conversation is created. Organization
channel policies still apply. A session that already enabled the receiver needs
no restart when Pacifico sends a message.

From any other terminal or MCP client:

```sh
pacifico send claude:<native-id> "Continue using your current context" --wait
```

The receiver uses the [official channel contract](https://code.claude.com/docs/en/channels-reference),
`notifications/claude/channel` and a correlated `reply` tool. Its user-only Unix
socket accepts local requests; it exposes no network listener and relays no
permission approvals. The receiving session keeps its own permissions. Both
processes must use the same Pacifico data directory. A normal MCP registration
without channel opt-in does not deliver notifications.

A socket write is not a delivery acknowledgement. Requests remain running until
Claude calls `reply`, and disconnection before a reply yields unknown delivery.
There is no automatic replay. If Claude never replies, the request stays running;
inspect the receiving terminal. An outstanding channel request blocks another
Pacifico message until replied to, even if its sending connection disappears.

## Next harnesses

After Claude and Codex delivery is validated, add OpenCode using its official
[session server API](https://opencode.ai/docs/server/). Then evaluate Antigravity
and Cursor using their official interfaces, separately verifying CLI sessions
and live IDE attachment. Reading a harness's files is not execution support.

The official Codex plugin for Claude provides a useful reference for request
tracking and App Server lifecycle. The
[Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
is a reference for SDK events and permissions. Neither third-party app-server
wrappers nor distributed message brokers are runtime dependencies.

## Design

CLI and MCP translate user input into one session service. The service owns
identity, availability and request/result correlation; adapters hide the native
wire formats and lifecycle. The connection module owns private IPC and process
startup. Core's transcript importers do not gain execution responsibilities.

Two alternatives were considered: one native process per request with resume,
or a persistent process per session. Persistent processes preserve live context
and avoid competing writers when the next message arrives. This costs a local
host, which is kept behind the same small start/send interface. Review and
advisor do not become specialized runtime operations.
