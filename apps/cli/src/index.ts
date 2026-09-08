import { basename } from 'node:path';
import { version } from '../../../package.json';
import { parseArgs, getRepoRoot, toSearchOptions } from './cli';
import { C } from '@pacifico/core/colors';
import { scanSessions } from '@pacifico/core/scanner';
import { formatLine, formatLineage } from './display';
import { selectSession } from './select';
import { copyToClipboard } from './clipboard';
import { buildResumeCommand } from '@pacifico/core/search-format';
import type { Tool } from '@pacifico/core/types';

if (Bun.argv.includes('--version') || Bun.argv.includes('-v')) {
  process.stdout.write(`pacifico ${version}\n`);
  process.exit(0);
}

if (Bun.argv.includes('--clear-cache')) {
  const { clearCache } = await import('@pacifico/core/cache');
  clearCache();
  process.exit(0);
}

// Hidden: invoked by the selector's fzf --preview / builtin preview key. Reads one
// session file and prints a compact conversation rendering. Not for users directly.
if (Bun.argv[2] === '--preview' && Bun.argv[3]) {
  const { renderPreview } = await import('./preview');
  process.stdout.write(renderPreview(Bun.argv[3]) + '\n');
  process.exit(0);
}

// Commands dispatch on the positional word only. Matching anywhere in argv
// (the old behavior) let a flag VALUE fire a command — `pacifico wrapped
// --out cleanup` would have uninstalled the plugin and wiped the index.
const command = Bun.argv[2];

if (command === 'daemon') {
  try {
    const { runDaemonCommand } = await import('@pacifico/agents/daemon');
    await runDaemonCommand(Bun.argv.slice(3));
  } catch (error) {
    process.stderr.write(`pacifico daemon: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'cleanup') {
  const { clearCache } = await import('@pacifico/core/cache');
  const { runUninstall } = await import('@pacifico/agents/setup');
  runUninstall();
  clearCache();
  process.exit(0);
}

if (Bun.argv.includes('--mcp')) {
  const { startMcpServer } = await import('@pacifico/agents/mcp');
  await startMcpServer();
  await new Promise(() => {});
}

if (command === 'setup' || command === 'install') {
  const { runSetup } = await import('@pacifico/agents/setup');
  runSetup({ hooks: Bun.argv.includes('--hooks') });
  process.exit(0);
}

if (command === 'uninstall') {
  const { runUninstall } = await import('@pacifico/agents/setup');
  runUninstall();
  process.exit(0);
}

if (command === 'report') {
  const { parseReportArgs, runReport } = await import('@pacifico/core/report/index');
  const opts = parseReportArgs(Bun.argv.slice(3));
  const res = await runReport(opts);
  if (!opts.stdout) {
    if (res.jsonPath) process.stderr.write(`wrote ${res.jsonPath}\n`);
    if (res.htmlPath) process.stderr.write(`wrote ${res.htmlPath}\n`);
  }
  if (res.htmlPath && !opts.out && !opts.stdout) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    Bun.spawnSync([opener, res.htmlPath]);
  }
  process.exit(0);
}

if (command === 'wrapped') {
  const { parseWrappedArgs, runWrapped } = await import('@pacifico/core/wrapped/index');
  const opts = parseWrappedArgs(Bun.argv.slice(3));
  const res = await runWrapped(opts);
  if (res.htmlPath) process.stderr.write(`wrote ${res.htmlPath}\n`);
  if (res.htmlPath && !opts.out && !opts.stdout) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    Bun.spawnSync([opener, res.htmlPath]);
  }
  process.exit(0);
}

if (command === 'context') {
  const { parseContextArgs, runContext } = await import('@pacifico/core/context');
  await runContext(parseContextArgs(Bun.argv.slice(3)));
  process.exit(0);
}

if (command === 'digest') {
  const { parseDigestArgs, runDigest } = await import('@pacifico/core/digest');
  await runDigest(parseDigestArgs(Bun.argv.slice(3)));
  process.exit(0);
}

if (command === 'memory') {
  const { runMemory } = await import('@pacifico/core/memory/cli');
  await runMemory(Bun.argv.slice(3));
  process.exit(0);
}

if (command === 'vault') {
  const { runVault } = await import('@pacifico/core/vault/cli');
  await runVault(Bun.argv.slice(3));
  process.exit(0);
}

if (command === 'why') {
  const { runWhy } = await import('@pacifico/core/why/cli');
  await runWhy(Bun.argv.slice(3));
  process.exit(0);
}

const args = parseArgs(Bun.argv.slice(2));
const repoRoot = getRepoRoot(args.scopeHere);

if (args.searchQuery) {
  process.stderr.write(`${C.dim}  searching sessions...${C.reset}`);
}

const { searchSessions } = await import('@pacifico/core/cache');
const { query, opts } = toSearchOptions(args, repoRoot);
let results;
try {
  results = await searchSessions(query, opts);
} catch {
  results = await scanSessions(repoRoot, args.toolFilter, args.searchQuery); // no-index fallback
}

if (results.length === 0) {
  if (args.searchQuery) process.stderr.write('\r\x1b[K');
  process.stderr.write(`${C.dim}No sessions found.${C.reset}\n`);
  process.exit(0);
}

const cols = parseInt(process.env.COLUMNS ?? '80', 10);
const lines = results.map((r) => formatLine(r, cols));

if (args.searchQuery) process.stderr.write('\r\x1b[K');

const selection = await selectSession(lines);
if (!selection) process.exit(0);

// TSV layout: filePath, cwd, tool, sessionId, exists, prompt, display
// (filePath leads so fzf --preview can reference {1}; the display column is what
// fzf shows and the builtin slices — both skip the leading metadata fields).
const parts = selection.split('\t');
const fullPath = parts[1]!;
const tool = parts[2]!;
const sessionId = parts[3]!;
const exists = parts[4]!;
const prompt = parts[5]!;
const dirName = basename(fullPath);

process.stderr.write('\n');
process.stderr.write(`  ${C.bold}${dirName}${C.reset} ${C.dim}(${tool})${C.reset}\n`);
if (prompt) {
  process.stderr.write(`  ${C.dim}${prompt}${C.reset}\n`);
}
// Lineage (pi /tree forks + /fork parent) comes from the SessionResult, not the TSV
// fields — match the selection back to its result by sessionId+tool. Display-only:
// formatLineage basenames the raw parent path and never joins it back to the index.
const selected = results.find((r) => r.sessionId === sessionId && r.tool === tool);
const lineage = selected ? formatLineage(selected) : '';
if (lineage) {
  process.stderr.write(`  ${C.dim}${lineage}${C.reset}\n`);
}
process.stderr.write('\n');

// SAFETY: the TSV field was written by formatLine from a SessionResult's Tool, and the
// find() above matched it back to that same result.
const resumeCmd = buildResumeCommand(tool as Tool, fullPath, sessionId);

if (exists === 'deleted') {
  process.stderr.write(`  ${C.red}○${C.reset} ${C.bold}${fullPath}${C.reset} no longer exists\n`);
  process.stderr.write(`  ${C.dim}Recreate the directory first, then resume:${C.reset}\n`);
  process.stderr.write('\n');
}

process.stderr.write(`  ${C.cyan}${resumeCmd}${C.reset}\n`);

const copied = await copyToClipboard(resumeCmd);
if (copied) {
  process.stderr.write(`  ${C.dim}(copied to clipboard)${C.reset}\n`);
}

process.stderr.write('\n');
