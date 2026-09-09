// src/cache.test.ts
import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { type JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run (cache.search.test.ts, cache.metrics.test.ts,
// context.test.ts, mcp.test.ts). So we (re)assert our env and reset the cached DB
// connection before each test - keeping this file hermetic regardless of which other
// cache-importing file ran first or interleaves.
let tmp: string;
let cache: typeof import('./cache');

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive'); // hermetic vault; keep off the real ~/.local/share
}

interface IndexedRow {
  message_count: number;
}

function indexedRow(filePath: string): IndexedRow | null {
  // Independent read-only connection (WAL allows concurrent readers) to assert
  // row-level state that the search API alone can't prove.
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    return (
      db.query<IndexedRow, [string]>('SELECT message_count FROM sessions WHERE file_path = ?').get(filePath) ?? null
    );
  } finally {
    db.close();
  }
}

function ignoredRow(filePath: string): { mtime: number; size: number } | null {
  const db = new Database(cache.getDbPath(), { readonly: true });
  try {
    return (
      db
        .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM ignored_files WHERE file_path = ?')
        .get(filePath) ?? null
    );
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pacifico-cache-migration-'));
  setEnv();
  mkdirSync(join(tmp, 'claude'), { recursive: true });
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // A Claude session for index migration.
  mkdirSync(join(tmp, 'claude', 'proj'), { recursive: true });
  writeFileSync(
    join(tmp, 'claude', 'proj', 'claudeone.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoClaude',
        timestamp: '2026-08-04T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello claude' }] },
        promptSource: 'typed',
      }),
    ].join('\n'),
  );

  cache = await import('./cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
});

test('schema bump: stale rows are recomputed by the drop+rebuild, and ignored_files is re-derived', async () => {
  const path = join(tmp, 'claude', 'proj', 'claudeone.jsonl');
  expect(indexedRow(path)?.message_count).toBe(1);

  // Seed the negative cache so the rebuild's treatment of ignored_files is observable.
  const ignoredPath = join(tmp, 'claude', 'proj', 'ignored.jsonl');
  writeFileSync(ignoredPath, JSON.stringify({ type: 'user', timestamp: '2026-08-04T12:00:00Z' }));
  await cache.refreshIndex();
  expect(ignoredRow(ignoredPath)).not.toBeNull();

  // Simulate a stale v9 row: a wrong stored value plus the old schema version.
  cache.closeDb();
  const db = new Database(cache.getDbPath());
  db.run('UPDATE sessions SET message_count = 999 WHERE file_path = ?', [path]);
  db.run('PRAGMA user_version = 9');
  db.close();

  // Reopen through the cache: openDb sees the user_version mismatch, drops ALL FOUR
  // tables (ignored_files included - negative-cache entries do NOT survive a rebuild),
  // and the refresh re-parses from the transcripts on disk.
  await cache.refreshIndex();

  // Assert the row EXISTS with the recomputed value: asserting !== 999 alone would
  // pass vacuously on the empty post-drop table.
  expect(indexedRow(path)?.message_count).toBe(1);
  // ignored_files was dropped with everything else and re-derived by the refresh.
  expect(ignoredRow(ignoredPath)).not.toBeNull();
});

test('v12 upgrade removes retired columns and vector storage without rebuilding text rows', async () => {
  const path = join(tmp, 'claude', 'proj', 'vector-upgrade.jsonl');
  writeFileSync(
    path,
    j({
      type: 'user',
      cwd: '/repo',
      timestamp: '2026-08-04T10:00:00Z',
      message: { role: 'user', content: 'migrationquartz' },
    }),
  );
  await cache.refreshIndex();
  cache.closeDb();
  const previous = new Database(cache.getDbPath());
  previous.run('CREATE TABLE session_vectors (file_path TEXT PRIMARY KEY, vec BLOB)');
  previous.run('ALTER TABLE sessions ADD COLUMN branches INTEGER DEFAULT 0');
  previous.run("ALTER TABLE sessions ADD COLUMN fork_points TEXT DEFAULT '[]'");
  previous.run("ALTER TABLE sessions ADD COLUMN forked_from TEXT DEFAULT ''");
  previous.run('PRAGMA user_version = 12');
  const before = previous.query('SELECT count(*) AS count FROM sessions').get();
  previous.run(`INSERT INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, first_prompt)
    VALUES ('retired-pi', 1, 1, '/repo', 'pi', 'retired', '2026-01-01', 'retiredquartz')`);
  previous.run(
    "INSERT INTO session_fts (file_path, headline, commands, paths) VALUES ('retired-pi', 'retiredquartz', '', '')",
  );
  previous.run(
    "INSERT INTO message_fts (file_path, msg_index, role, text) VALUES ('retired-pi', 0, 'user', 'retiredquartz')",
  );
  previous.close();
  cache.sessionExcerpts(path, 'migrationquartz', 1);
  const migrated = new Database(cache.getDbPath(), { readonly: true });
  expect(migrated.query('PRAGMA user_version').get()).toEqual({ user_version: 14 });
  const columns = migrated
    .query<{ name: string }, []>('PRAGMA table_info(sessions)')
    .all()
    .map((c) => c.name);
  for (const name of ['branches', 'fork_points', 'forked_from']) expect(columns).not.toContain(name);
  expect(migrated.query('SELECT count(*) AS count FROM sessions').get()).toEqual(before);
  expect(migrated.query("SELECT file_path FROM sessions WHERE tool = 'pi'").all()).toEqual([]);
  expect(migrated.query("SELECT file_path FROM session_fts WHERE session_fts MATCH 'retiredquartz'").all()).toEqual([]);
  expect(migrated.query("SELECT file_path FROM message_fts WHERE message_fts MATCH 'retiredquartz'").all()).toEqual([]);
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name = 'session_vectors'").get()).toBeNull();
  expect(
    migrated.query("SELECT count(*) AS count FROM message_fts WHERE message_fts MATCH 'migrationquartz'").get(),
  ).toEqual({ count: 1 });
  migrated.close();
});
