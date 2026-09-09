import { C, disableColors } from '@pacifico/core/colors';
import { type Tool, type CliArgs } from '@pacifico/core/types';
import type { SearchOptions } from '@pacifico/core/cache';
import { resolveRepo } from '@pacifico/core/repo';

const VALID_TOOLS = new Set<string>(['claude', 'codex', 'opencode', 'cursor', 'antigravity']);

function usage(): never {
  process.stderr.write(`${C.bold}pacifico${C.reset} - find and resume AI coding sessions

Browse sessions from Claude Code, Codex, Cursor, Antigravity, and OpenCode with fuzzy search.
Scoped to the current git repo.

${C.bold}Usage:${C.reset}
  pacifico                    Browse all sessions with fzf
  pacifico <query>            Search session content for a phrase
  pacifico --here             Scope to current repo only

${C.bold}Options:${C.reset}
  --here           Scope to current git repo (default: all projects)
  --tool <name>    Filter: claude, codex, cursor, antigravity, opencode
  --errored        Only sessions that hit an error
  --file <path>    Only sessions that touched or read this path (substring
                   match; repeatable - every path must match). Newest first
                   when no query is given
  --mcp            Start as an MCP server (stdio transport)
  --clear-cache    Remove the search index (rebuilds on next use)
  -v, --version    Print the CLI version
  -h, --help       Show this help

${C.bold}Commands:${C.reset}
  remote connect  Connect this computer to a self-hosted server
  remote sync     Import and upload pending local snapshots
  remote status   Show the configured endpoint and device
  remote search   Search the remote archive
  remote read     Read a remote session by its returned identifier
  remote context  Get project context or activity from the remote archive
  remote documents Search and read archived native memories and instructions
  remote --help   Show remote query options
  daemon start     Enable background import every 30 seconds (macOS)
  daemon stop      Stop background import and disable it at login
  daemon status    Print service state and the last import result as JSON
  daemon run       Import and archive once, then exit
  context          Print a context primer for the current repo (markdown)
                   --full widens detail; --limit/--days/--tool filter; --worktree
                   narrows to the current worktree; --out <path> writes to a file
  why <target>     Why does this code exist? Correlate a file, file:line, commit-ish,
                   or free-text topic to the AI sessions behind it. Read-only on git
                   and the index; --json emits the structured evidence
  digest <session> Print the arc of one session as compact markdown (~8k chars):
                   each genuine user turn with its exchange's final assistant
                   reply. Accepts a JSONL file path or an indexed session id
  report           Generate a usage report (HTML dashboard, opens in browser)
                   --out <path> saves instead of opening; --format json|html|both
                   (default html); --stdout prints JSON; --here scopes to the
                   current project; --from/--to/--days/--month limit the period
  wrapped          Your year with AI agents, Spotify-Wrapped style (opens in
                   browser). --year <YYYY> wraps a past year; --out/--stdout,
                   --tool, --extras <json> add agent-authored slides
  vault status     Show the durable transcript archive: per-tool counts, total
                   bytes, and how many sessions are vault-only (source gone)
  vault inspect    Show one archived session by original path or session id
                   (<target>); prints whether it is live, archived, or both
  install / setup            Install plugin and configure MCP for detected tools
  uninstall        Remove plugin and MCP config
  cleanup          Uninstall plugin + clear search index (full reset)

${C.bold}Search:${C.reset}
  With no argument, opens fzf with session summaries.
  With an argument, greps across session content for matching
  sessions, then opens fzf with the results.
`);
  process.exit(0);
}

function die(msg: string): never {
  process.stderr.write(`${C.red}error:${C.reset} ${msg}\n`);
  process.exit(1);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { toolFilter: '', searchQuery: '', scopeHere: false, errored: false, files: [] };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        usage();
      case '--tool':
        i++;
        if (!argv[i] || !VALID_TOOLS.has(argv[i]!)) {
          die(`--tool requires one of: claude, codex, opencode`);
        }
        // SAFETY: VALID_TOOLS.has() above proves argv[i] is a Tool.
        args.toolFilter = argv[i] as Tool;
        break;
      case '--here':
        args.scopeHere = true;
        break;
      case '--errored':
        args.errored = true;
        break;
      case '--file':
        i++;
        if (!argv[i]) die(`--file requires a path`);
        args.files.push(argv[i]!);
        break;
      case '--no-color':
        disableColors();
        break;
      default:
        if (arg.startsWith('-')) die(`unknown option: ${arg}`);
        args.searchQuery = arg;
    }
    i++;
  }

  return args;
}

export function getRepoRoot(scopeHere: boolean): string {
  if (!scopeHere) return '';

  // Delegate to the git-common-dir based resolver. Its `container` is the tree
  // holding all worktrees (bare or normal), replacing the old `../.git`+`.bare`
  // string match. Fall back to the cwd when not in a git repo.
  const repo = resolveRepo(process.cwd());
  return repo ? repo.container : process.cwd();
}

/** The single mapping from CLI args to a searchSessions() call (keeps the CLI a thin shell). */
interface SearchCall {
  query: string;
  opts: SearchOptions;
}

export function toSearchOptions(args: CliArgs, repoRoot: string): SearchCall {
  return {
    query: args.searchQuery,
    opts: { tool: args.toolFilter, project: repoRoot, errored: args.errored, files: args.files, limit: 1000 },
  };
}
