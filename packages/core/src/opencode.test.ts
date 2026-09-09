import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  getOpencodeDbPath,
  opencodeFilePath,
  isOpencodePath,
  sessionIdFromPath,
  discoverOpencodeSessions,
  opencodeStat,
  readOpencodeSession,
  collectOpencodeSubagentText,
  closeOpencodeDb,
} from './opencode';
import { readSessionLines } from './session-io';
import { getCwdFromSession, firstPrompt, customTitle, messageCount } from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import type { JsonValue } from './extract-util';

const j = (o: JsonValue): string => JSON.stringify(o);

let tmp: string;
let dbPath: string;

// A minimal OpenCode DB with the exact columns src/opencode.ts and the report parser read.
function buildFixtureDb(path: string): void {
  const db = new Database(path);
  db.run(
    'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)',
  );
  db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)');
  db.run('CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)');

  const session = db.query(
    'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const message = db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  const part = db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');

  // Parent session: a real (non-placeholder) title, a user turn, and an assistant turn
  // whose parts cover every synthesized block type.
  session.run('ses_parent', 'p1', null, '/repo/app', 'Refactor the router', 1000, 2000);
  message.run('msg_u1', 'ses_parent', 1100, j({ role: 'user', time: { created: 1100 } }));
  part.run('prt_u1', 'msg_u1', 'ses_parent', 1100, j({ type: 'text', text: 'please refactor the router lazerhawk' }));
  message.run(
    'msg_a1',
    'ses_parent',
    1500,
    j({
      role: 'assistant',
      time: { created: 1500 },
      modelID: 'claude-opus-4-6',
      providerID: 'anthropic',
      cost: 0.05,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 30 } },
    }),
  );
  part.run('prt_a1', 'msg_a1', 'ses_parent', 1500, j({ type: 'reasoning', text: 'thinking about zorptastic' }));
  part.run('prt_a2', 'msg_a1', 'ses_parent', 1501, j({ type: 'text', text: 'Done refactoring' }));
  part.run(
    'prt_a3',
    'msg_a1',
    'ses_parent',
    1502,
    j({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' } } }),
  );
  part.run(
    'prt_a4',
    'msg_a1',
    'ses_parent',
    1503,
    j({ type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/repo/app/router.ts' } } }),
  );
  part.run(
    'prt_a5',
    'msg_a1',
    'ses_parent',
    1504,
    j({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/repo/app/old.ts' } } }),
  );
  part.run('prt_a6', 'msg_a1', 'ses_parent', 1505, j({ type: 'patch', files: ['/repo/app/router.ts'] }));
  part.run(
    'prt_a7',
    'msg_a1',
    'ses_parent',
    1506,
    j({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'x' }, error: 'boom quux' } }),
  );

  // Child session retains its own identity and its native parent relationship.
  session.run('ses_child', 'p1', 'ses_parent', '/repo/app', 'Explore (@explore subagent)', 1200, 1400);
  message.run('msg_u2', 'ses_child', 1200, j({ role: 'user', time: { created: 1200 } }));
  part.run('prt_u2', 'msg_u2', 'ses_child', 1200, j({ type: 'text', text: 'subagent secret term wibbleflorp' }));

  // Placeholder-title session - the auto "New session -" title must be dropped.
  session.run('ses_plain', 'p2', null, '/repo/other', 'New session - 2026-07-11T00:00:00.000Z', 3000, 3500);
  message.run('msg_u3', 'ses_plain', 3000, j({ role: 'user', time: { created: 3000 } }));
  part.run('prt_u3', 'msg_u3', 'ses_plain', 3000, j({ type: 'text', text: 'hello there' }));

  db.close();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-oc-'));
  dbPath = join(tmp, 'opencode.db');
  buildFixtureDb(dbPath);
  process.env.SESSIONS_OPENCODE_DB = dbPath;
  closeOpencodeDb();
});

afterAll(() => {
  closeOpencodeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('opencode module', () => {
  test('exports complete source rows alongside the search projection', () => {
    const source = JSON.parse(readOpencodeSession(opencodeFilePath('ses_parent'))[0]!);
    const native = new Database(dbPath, { readonly: true });
    try {
      expect(source.type).toBe('source_records');
      expect(source.session).toEqual(native.query('SELECT * FROM session WHERE id = ?').get('ses_parent'));
      expect(source.messages).toEqual(
        native.query('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all('ses_parent'),
      );
      expect(source.parts).toEqual(
        native.query('SELECT * FROM part WHERE session_id = ? ORDER BY time_created, id').all('ses_parent'),
      );
    } finally {
      native.close();
    }
  });

  test('path helpers round-trip and detect OpenCode paths', () => {
    const p = opencodeFilePath('ses_parent');
    expect(sessionIdFromPath(p)).toBe('ses_parent');
    expect(isOpencodePath(p)).toBe(true);
    expect(isOpencodePath('/home/x/.claude/projects/p/abc.jsonl')).toBe(false);
  });

  test('discovers parent and child sessions independently', () => {
    const ids = discoverOpencodeSessions()
      .map((s) => sessionIdFromPath(s.path))
      .sort();
    expect(ids).toEqual(['ses_child', 'ses_parent', 'ses_plain']);
    const child = JSON.parse(readOpencodeSession(opencodeFilePath('ses_child'))[0]!);
    expect(child.session.parent_id).toBe('ses_parent');
    expect(child.messages).toHaveLength(1);
    expect(child.parts).toHaveLength(1);
  });

  test('stat includes database changes and rejects missing sessions', () => {
    expect(opencodeStat(opencodeFilePath('ses_parent'))!.mtimeMs).toBeGreaterThanOrEqual(2000);
    expect(opencodeStat(opencodeFilePath('ses_parent'))!.size).toBeGreaterThan(2);
    expect(opencodeStat(opencodeFilePath('ses_missing'))).toBeNull();
  });

  test('a WAL part update invalidates an otherwise unchanged session', () => {
    const isolated = join(tmp, 'wal-test.db');
    buildFixtureDb(isolated);
    closeOpencodeDb();
    process.env.SESSIONS_OPENCODE_DB = isolated;
    const writer = new Database(isolated);
    try {
      writer.exec('PRAGMA journal_mode=WAL');
      const before = opencodeStat(opencodeFilePath('ses_parent'));
      const original = writer.query<{ data: string }, []>("SELECT data FROM part WHERE id = 'prt_u1'").get()!.data;
      writer
        .query("UPDATE part SET data = ? WHERE id = 'prt_u1'")
        .run(j({ type: 'text', text: 'updated independently' }));
      expect(opencodeStat(opencodeFilePath('ses_parent'))).not.toEqual(before);
      writer.query("UPDATE part SET data = ? WHERE id = 'prt_u1'").run(original);
    } finally {
      closeOpencodeDb();
      writer.close();
      process.env.SESSIONS_OPENCODE_DB = dbPath;
    }
  });

  test('synthesizes lines the shared parser understands', () => {
    const lines = readSessionLines(opencodeFilePath('ses_parent'));
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/app');
    expect(firstPrompt(lines, 'opencode')).toBe('please refactor the router lazerhawk');
    expect(customTitle(lines)).toBe('Refactor the router');
    expect(messageCount(lines)).toBe(2); // one user + one assistant
  });

  test('drops the auto-generated "New session -" placeholder title', () => {
    const lines = readSessionLines(opencodeFilePath('ses_plain'), 'opencode');
    expect(getCwdFromSession(lines, 'opencode')).toBe('/repo/other');
    expect(customTitle(lines)).toBe('');
  });

  test('extractors read the synthesized OpenCode blocks', () => {
    const lines = readOpencodeSession(opencodeFilePath('ses_parent'));
    expect(extractFiles(lines, 'opencode')).toEqual(['/repo/app/router.ts']);
    expect(extractFilesRead(lines, 'opencode')).toEqual(['/repo/app/old.ts']);
    expect(extractCommands(lines, 'opencode')).toEqual(['bun test', 'x']); // a failed command still ran
    expect(extractThinking(lines, 'opencode')).toBe('thinking about zorptastic');
    const errors = extractErrors(lines, 'opencode');
    expect(errors.errored).toBe(true);
    expect(errors.messages[0]).toBe('boom quux');
  });

  test('collects subagent user text for parent-session recall', () => {
    expect(collectOpencodeSubagentText(opencodeFilePath('ses_parent'))).toBe('subagent secret term wibbleflorp');
    expect(collectOpencodeSubagentText(opencodeFilePath('ses_plain'))).toBe('');
  });

  test('a deleted DB stops being discoverable despite a cached handle', () => {
    // Long-running-process scenario (e.g. the MCP server): the handle is opened,
    // then the DB file is deleted out from under it - sessions must vanish, not
    // keep being served off the open inode.
    const copyPath = join(tmp, 'opencode-copy.db');
    copyFileSync(dbPath, copyPath);
    process.env.SESSIONS_OPENCODE_DB = copyPath;
    closeOpencodeDb();
    expect(discoverOpencodeSessions()).toHaveLength(3); // handle now open + cached
    rmSync(copyPath);
    expect(discoverOpencodeSessions()).toEqual([]);
    process.env.SESSIONS_OPENCODE_DB = dbPath;
    closeOpencodeDb();
  });
});

describe('opencode cache integration', () => {
  let cache: typeof import('./cache');

  beforeAll(async () => {
    // Point every source at hermetic locations; only OpenCode has a (fixture) DB.
    process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
    process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
    process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
    process.env.SESSIONS_OPENCODE_DB = dbPath;
    process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'archive'); // hermetic vault; keep off the real ~/.local/share
    for (const d of ['cache', 'claude', 'codex']) mkdirSync(join(tmp, d), { recursive: true });
    cache = await import('./cache');
    cache.closeDb();
  });

  afterAll(() => cache.closeDb());

  test('indexes OpenCode sessions and builds a resume command', async () => {
    const results = await cache.searchSessions('lazerhawk');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tool: 'opencode',
      cwd: '/repo/app',
      sessionId: 'ses_parent',
      customTitle: 'Refactor the router',
      errored: true,
    });
    expect(results[0]!.files).toEqual(['/repo/app/router.ts', '/repo/app/old.ts']);
    const { buildResumeCommand } = await import('./search-format');
    expect(buildResumeCommand('opencode', results[0]!.cwd, results[0]!.sessionId)).toBe(
      'cd "/repo/app" && opencode --session ses_parent',
    );
  });

  test('child text makes both the child and parent findable', async () => {
    const results = await cache.searchSessions('wibbleflorp');
    expect(results.map((r) => r.sessionId).sort()).toEqual(['ses_child', 'ses_parent']);
  });

  test('lists all native sessions when filtered to the opencode tool', async () => {
    const results = await cache.searchSessions('', { tool: 'opencode', limit: 100 });
    expect(results.map((r) => r.sessionId).sort()).toEqual(['ses_child', 'ses_parent', 'ses_plain']);
  });
});

test('OpenCode child source records survive database deletion and index rebuild', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-opencode-recovery-'));
  const environment = {
    SESSIONS_OPENCODE_DB: join(root, 'opencode.db'),
    SESSIONS_CACHE_DIR: join(root, 'cache'),
    SESSIONS_ARCHIVE_DIR: join(root, 'archive'),
    SESSIONS_NATIVE_HOME: root,
    SESSIONS_CLAUDE_DIR: join(root, 'claude'),
    SESSIONS_CODEX_DIR: join(root, 'codex'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(root, 'codex-archived'),
    SESSIONS_CURSOR_DIR: join(root, 'cursor'),
    SESSIONS_ANTIGRAVITY_DIR: join(root, 'gemini'),
  };
  const prior = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const cache = await import('./cache');
  Object.assign(process.env, environment);
  cache.closeDb();
  closeOpencodeDb();
  try {
    buildFixtureDb(environment.SESSIONS_OPENCODE_DB);
    const before = (await cache.searchSessions('wibbleflorp')).find((row) => row.sessionId === 'ses_child')!;
    expect(before).toBeDefined();
    const original = readSessionLines(before.filePath, 'opencode');
    closeOpencodeDb();
    rmSync(environment.SESSIONS_OPENCODE_DB);
    cache.closeDb();
    cache.clearCache();
    const recoveredResults = await cache.searchSessions('wibbleflorp');
    expect(recoveredResults.map((row) => row.sessionId).sort()).toEqual(['ses_child', 'ses_parent']);
    const recovered = recoveredResults.find((row) => row.sessionId === 'ses_child')!;
    expect(recovered).toBeDefined();
    expect(readSessionLines(recovered.filePath, 'opencode')).toEqual(original);
    const source = JSON.parse(original[0]!);
    expect(source.session.parent_id).toBe('ses_parent');
    expect(source.parts[0].session_id).toBe('ses_child');
  } finally {
    cache.closeDb();
    closeOpencodeDb();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('opencode report parser', () => {
  test('emits one usage event per assistant message with tokens + pre-computed cost', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    const events = await parseOpencode(dbPath);
    expect(events).toHaveLength(1); // only ses_parent's assistant turn carries tokens
    expect(events[0]).toMatchObject({
      tool: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      sessionId: 'ses_parent',
      projectPath: '/repo/app',
      // reasoning tokens fold into output (50 + 10)
      tokens: { input: 100, output: 60, cacheRead: 200, cacheWrite: 30 },
      costUSD: 0.05,
    });
  });

  test('returns [] for a missing DB', async () => {
    const { parseOpencode } = await import('./report/parsers/opencode');
    expect(await parseOpencode(join(tmp, 'nope.db'))).toEqual([]);
  });
});

test('OpenCode source defaults honor Pacifico home and explicit database precedence', () => {
  const home = process.env.SESSIONS_HOME;
  const database = process.env.SESSIONS_OPENCODE_DB;
  try {
    process.env.SESSIONS_HOME = '/fixture/pacifico-home';
    delete process.env.SESSIONS_OPENCODE_DB;
    expect(getOpencodeDbPath()).toBe('/fixture/pacifico-home/.local/share/opencode/opencode.db');
    process.env.SESSIONS_OPENCODE_DB = '/fixture/custom.db';
    expect(getOpencodeDbPath()).toBe('/fixture/custom.db');
  } finally {
    if (home === undefined) delete process.env.SESSIONS_HOME;
    else process.env.SESSIONS_HOME = home;
    if (database === undefined) delete process.env.SESSIONS_OPENCODE_DB;
    else process.env.SESSIONS_OPENCODE_DB = database;
  }
});
