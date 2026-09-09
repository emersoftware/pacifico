import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './cache';

/** realpathSync because macOS resolves /var -> /private/var, and git's --show-toplevel
 *  reports the real path - an unresolved fixture path would never compare equal. */
export function makeTmp(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `sessions-${label}-`)));
}

/**
 * Point every source root, the index, and the durable store at one temporary tree.
 * Re-assert this in `beforeEach`: cache.ts is a shared module
 * instance across a `bun test` run, so another file's env would otherwise leak in.
 */
export function setSessionEnv(tmp: string): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent -> no OpenCode sessions leak in
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data');
  // Shadow any SESSIONS_ARCHIVE_DIR another file leaked: it overrides the DATA_DIR
  // default, so an unset here would let a prior test's still-present vault leak
  // sessions into discovery.
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'data', 'archive');
}

/** Release the shared index handle so the next call reopens against the current env. */
export function closeDatabases(): void {
  closeDb();
}

export function claudeDir(tmp: string): string {
  return join(tmp, 'claude');
}

/** A genuine typed human turn: `promptSource: 'typed'` is what parser.ts requires. */
export function userTurn(text: string, timestamp: string) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
    promptSource: 'typed',
  };
}

export function assistantTurn(text: string, timestamp: string) {
  return {
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

/** Write a Claude transcript at <claudeDir>/proj/<id>.jsonl with `cwd` on every line. */
export function writeSession(tmp: string, id: string, cwd: string, records: JsonObject[]): string {
  const dir = join(claudeDir(tmp), 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => JSON.stringify({ ...r, cwd })).join('\n');
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines);
  return path;
}
