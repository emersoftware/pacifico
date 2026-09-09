import { Database } from 'bun:sqlite';
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getHome } from '../paths';

const SCHEMA_VERSION = 14;
let _db: Database | null = null;

export function getCacheDir(): string {
  return process.env.SESSIONS_CACHE_DIR || join(getHome(), '.cache', 'pacifico');
}

export function getDbPath(): string {
  return join(getCacheDir(), 'index.db');
}

/** Releases the disposable index connection without touching the durable archive. */
export function closeIndex(): void {
  try {
    _db?.close();
  } finally {
    _db = null;
  }
}

function openDb(): Database {
  const db = new Database(getDbPath());
  try {
    db.run('PRAGMA busy_timeout=5000');
    db.run('PRAGMA journal_mode=WAL');
    db.run('PRAGMA synchronous=NORMAL');

    const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    if (row?.user_version === 12 || row?.user_version === 13) {
      db.transaction(() => {
        db.run('DROP TABLE IF EXISTS session_vectors');
        const columns = new Set(
          db
            .query<{ name: string }, []>('PRAGMA table_info(sessions)')
            .all()
            .map((c) => c.name),
        );
        for (const column of ['branches', 'fork_points', 'forked_from']) {
          if (columns.has(column)) db.run(`ALTER TABLE sessions DROP COLUMN ${column}`);
        }
        db.run("DELETE FROM message_fts WHERE file_path IN (SELECT file_path FROM sessions WHERE tool = 'pi')");
        db.run("DELETE FROM session_fts WHERE file_path IN (SELECT file_path FROM sessions WHERE tool = 'pi')");
        db.run("DELETE FROM sessions WHERE tool = 'pi'");
        db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      })();
    } else if (!row || row.user_version !== SCHEMA_VERSION) {
      db.run('DROP TABLE IF EXISTS sessions');
      db.run('DROP TABLE IF EXISTS session_fts');
      db.run('DROP TABLE IF EXISTS message_fts');
      db.run('DROP TABLE IF EXISTS ignored_files');
      db.run('DROP TABLE IF EXISTS session_vectors');
      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      tool TEXT NOT NULL,
      session_id TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '?',
      started_at TEXT NOT NULL DEFAULT '',
      ended_at TEXT NOT NULL DEFAULT '',
      first_prompt TEXT NOT NULL,
      custom_title TEXT NOT NULL DEFAULT '',
      message_count INTEGER NOT NULL DEFAULT 0,
      files_touched TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      commands TEXT NOT NULL DEFAULT '[]',
      errored INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      closing_user TEXT NOT NULL DEFAULT '',
      closing_assistant TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT ''
    )
  `);
    db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      file_path UNINDEXED,
      headline,
      commands,
      paths,
      context_text,
      thinking,
      tokenize = 'porter unicode61'
    )
  `);
    db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      file_path UNINDEXED,
      msg_index UNINDEXED,
      role UNINDEXED,
      text,
      tokenize = 'porter unicode61'
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS ignored_files (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL
    )
  `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function removeDbFiles(): void {
  const dbPath = getDbPath();
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      unlinkSync(f);
    } catch {}
  }
}
function isCorruption(cause: unknown): boolean {
  const msg = cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  return msg.includes('malformed') || msg.includes('corrupt') || msg.includes('not a database');
}

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(getCacheDir(), { recursive: true });
  try {
    _db = openDb();
  } catch (e) {
    if (!isCorruption(e)) throw e;
    removeDbFiles();
    _db = openDb();
  }
  return _db;
}
