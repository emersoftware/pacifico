import { buildContent, isoTime } from './opencode-content';
import {
  discoverLegacyOpencode,
  isLegacyOpencodePath,
  readLegacyOpencode,
  statLegacyOpencode,
} from './opencode-legacy';
import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { getHome } from '../paths';
import { join, dirname, basename } from 'node:path';
import { type Tool } from '../types';
import { tryParse, asJsonObject, asJsonNumber, type JsonObject } from '../extract-util';

// OpenCode stores sessions in a single SQLite database (it migrated off the old
// file-per-session `storage/` layout). Everything else in this codebase reads one
// JSONL file per session into `lines: string[]`; this module bridges that gap by
// synthesizing an equivalent `lines[]` from the DB's session/message/part tables,
// so the parser and extractors treat OpenCode like any other tool. Env override
// keeps tests hermetic (they point at a temp fixture DB), matching SESSIONS_*_DIR.

/** Absolute path to the OpenCode SQLite DB, honoring SESSIONS_OPENCODE_DB. I.e. ~/.local/share/opencode/opencode.db */
export function getOpencodeDbPath(): string {
  return process.env.SESSIONS_OPENCODE_DB || join(getHome(), '.local/share/opencode/opencode.db');
}

/** Synthetic file_path for a session: join(dbPath, sessionId) so dirname===dbPath and basename===sessionId. */
export function opencodeFilePath(sessionId: string): string {
  return join(getOpencodeDbPath(), sessionId);
}

/** Whether a stored file_path denotes an OpenCode session (its parent dir is the DB file). */
export function isOpencodePath(filePath: string): boolean {
  return dirname(filePath) === getOpencodeDbPath() || isLegacyOpencodePath(filePath, getOpencodeDbPath());
}

/** The `ses_…` id embedded in a synthetic OpenCode file_path. I.e. basename of join(dbPath, id). */
export function sessionIdFromPath(filePath: string): string {
  return basename(filePath);
}

let _conn: { path: string; db: Database } | null = null;

/** Cached read-only DB handle for the current db path, or null if the DB is absent/unreadable.
 *  Re-checks existence even on a cache hit so a DB deleted mid-process (e.g. under a
 *  long-running MCP server) stops serving stale sessions instead of riding the open inode. */
function db(): Database | null {
  const path = getOpencodeDbPath();
  if (_conn && _conn.path === path && existsSync(path)) return _conn.db;
  closeOpencodeDb();
  if (!existsSync(path)) return null;
  try {
    // Read-only so we never contend with a running OpenCode's write lock (WAL mode).
    const opened = new Database(path, { readonly: true });
    opened.run('PRAGMA busy_timeout=5000');
    _conn = { path, db: opened };
    return opened;
  } catch {
    return null;
  }
}

/** Close and drop the cached DB handle so the next call reopens against getOpencodeDbPath(). Idempotent. */
export function closeOpencodeDb(): void {
  try {
    _conn?.db.close();
  } catch {}
  _conn = null;
}

/** A discovered session as a synthetic file path (OpenCode keeps a DB, not files). */
interface DiscoveredSession {
  path: string;
  tool: Tool;
}

/** Discover every native session; child snapshots retain their parent_id in source records. */
export function discoverOpencodeSessions(): DiscoveredSession[] {
  const legacy = discoverLegacyOpencode(getOpencodeDbPath());
  const d = db();
  if (!d) return legacy;
  try {
    const rows = d.query<{ id: string }, []>('SELECT id FROM session ORDER BY id').all();
    return [...rows.map((r) => ({ path: opencodeFilePath(r.id), tool: 'opencode' as const })), ...legacy];
  } catch {
    return legacy;
  }
}

/** Include database/WAL changes because parts can change without a session timestamp update. */
export function opencodeStat(filePath: string): { mtimeMs: number; size: number } | null {
  if (isLegacyOpencodePath(filePath, getOpencodeDbPath())) return statLegacyOpencode(filePath);
  const d = db();
  if (!d) return null;
  const id = sessionIdFromPath(filePath);
  try {
    const row = d
      .query<{ time_updated: number; c: number }, [string, string]>(
        'SELECT time_updated, (SELECT COUNT(*) FROM message WHERE session_id = ?) AS c FROM session WHERE id = ?',
      )
      .get(id, id);
    if (!row) return null;
    const files = [getOpencodeDbPath(), getOpencodeDbPath() + '-wal'];
    let mtimeMs = row.time_updated;
    let size = row.c;
    for (const path of files) {
      try {
        const stat = statSync(path);
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        size += stat.size;
      } catch {}
    }
    return { mtimeMs, size };
  } catch {
    return null;
  }
}

/**
 * Reconstruct a session as JSONL-style `lines[]` built entirely from shapes the
 * shared parser already understands: a `session` line carrying the cwd,
 * an optional `custom-title` line, then one `message` line per turn whose
 * `message.content[]` mixes text, thinking, tool, and patch blocks (the generic
 * shared `type:'message'` shape).
 */
export function readOpencodeSession(filePath: string): string[] {
  if (isLegacyOpencodePath(filePath, getOpencodeDbPath())) return readLegacyOpencode(filePath);
  const d = db();
  if (!d) return [];
  return d.transaction(() => readSessionSnapshot(d, sessionIdFromPath(filePath)))();
}

function readSessionSnapshot(d: Database, id: string): string[] {
  const session = d
    .query<{ directory: string; title: string; time_created: number }, [string]>(
      'SELECT directory, title, time_created FROM session WHERE id = ?',
    )
    .get(id);
  if (!session) return [];

  const lines: string[] = [];
  // Keep exact JSON column strings and row metadata, including unknown parts.
  // This record is archival evidence, separate from the searchable projection.
  lines.push(
    JSON.stringify({
      type: 'source_records',
      source: 'opencode',
      session: d.query('SELECT * FROM session WHERE id = ?').get(id),
      messages: d.query('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all(id),
      parts: d.query('SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id').all(id),
    }),
  );
  lines.push(
    JSON.stringify({
      type: 'session',
      sessionId: id,
      subagentText: collectOpencodeSubagentText(opencodeFilePath(id)),
      cwd: session.directory,
      timestamp: isoTime(session.time_created),
    }),
  );
  // Skip OpenCode's auto-generated "New session - <date>" placeholder; a real,
  // summarized title becomes a custom-title (reused by display/context as the intent).
  if (session.title && !session.title.startsWith('New session')) {
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: session.title }));
  }

  const messages = d
    .query<{ id: string; data: string }, [string]>(
      'SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(id);
  const partsByMessage = partsBySession(d, id);

  for (const m of messages) {
    const md = tryParse(m.data);
    const role = md?.role === 'assistant' ? 'assistant' : 'user';
    const ts = isoTime(asJsonNumber(asJsonObject(md?.time)?.created) ?? session.time_created);
    const content = buildContent(partsByMessage.get(m.id) ?? []);
    if (content.length === 0) continue; // e.g. a synthetic/empty turn with no renderable parts
    lines.push(JSON.stringify({ type: 'message', timestamp: ts, message: { role, content } }));
  }

  return lines;
}

/**
 * Serialize an OpenCode session to the normalized JSONL text the vault archives.
 *
 * The export contains source rows as well as the searchable message projection.
 * Reads share one SQLite transaction so both describe the same committed state.
 * Empty string means the native session is no longer present.
 */
export function serializeOpencodeSession(filePath: string): string {
  return readOpencodeSession(filePath).join('\n');
}

/** Genuine user text across a session's subagent (child) sessions, for parent-session search recall. */
export function collectOpencodeSubagentText(filePath: string): string {
  const d = db();
  if (!d) return '';
  const id = sessionIdFromPath(filePath);
  try {
    const rows = d
      .query<{ text: string }, [string]>(
        `SELECT json_extract(p.data, '$.text') AS text
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id IN (SELECT id FROM session WHERE parent_id = ?)
           AND json_extract(p.data, '$.type') = 'text'
           AND json_extract(m.data, '$.role') = 'user'
         ORDER BY p.session_id, p.time_created, p.id`,
      )
      .all(id);
    return rows
      .map((r) => r.text)
      .filter((t) => t !== null && t.length > 0)
      .join('\n');
  } catch {
    return '';
  }
}

// --- helpers ---

/** All parts of a session grouped by message id, preserving stable chronological order. */
function partsBySession(d: Database, sessionId: string): Map<string, JsonObject[]> {
  const byMessage = new Map<string, JsonObject[]>();
  const rows = d
    .query<{ message_id: string; data: string }, [string]>(
      'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC',
    )
    .all(sessionId);
  for (const r of rows) {
    const parsed = tryParse(r.data);
    if (!parsed) continue;
    const list = byMessage.get(r.message_id) ?? [];
    list.push(parsed);
    byMessage.set(r.message_id, list);
  }
  return byMessage;
}
