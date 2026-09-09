import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverOpencodeSessions, opencodeStat, readOpencodeSession, closeOpencodeDb } from './opencode';
import { readSessionLines } from '../session-io';
import { extractMessages } from '../parser';
import { closeDb, clearCache, searchSessions, refreshIndex } from '../cache';

test('legacy JSON sessions retain raw files, detect part changes and recover from the archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-opencode-json-'));
  const environment = {
    SESSIONS_HOME: root,
    SESSIONS_NATIVE_HOME: root,
    SESSIONS_OPENCODE_DB: join(root, 'data/opencode.db'),
    SESSIONS_CACHE_DIR: join(root, 'cache'),
    SESSIONS_ARCHIVE_DIR: join(root, 'archive'),
    SESSIONS_CLAUDE_DIR: join(root, 'claude'),
    SESSIONS_CODEX_DIR: join(root, 'codex'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(root, 'codex-archived'),
    SESSIONS_CURSOR_DIR: join(root, 'cursor'),
    SESSIONS_CURSOR_IDE_DIR: join(root, 'cursor-ide'),
    SESSIONS_ANTIGRAVITY_DIR: join(root, 'gemini'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  closeDb();
  closeOpencodeDb();
  const storage = join(root, 'data/storage');
  const write = (relative: string, value: unknown) => {
    const path = join(storage, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  try {
    const session = write('session/project/ses_old.json', {
      id: 'ses_old',
      parentID: 'ses_parent',
      directory: '/repo/legacy',
      title: 'Historical session',
      time: { created: 10 },
      unknown: { retained: true },
    });
    write('message/ses_old/msg_2.json', { id: 'msg_2', role: 'assistant', time: { created: 30 } });
    write('message/ses_old/msg_1.json', { id: 'msg_1', role: 'user', time: { created: 20 } });
    const part = write('part/msg_1/prt_1.json', { id: 'prt_1', type: 'text', text: 'legacyquartz alpha' });
    write('part/msg_2/prt_2.json', { id: 'prt_2', type: 'reasoning', text: 'native reasoning' });
    write('part/msg_2/prt_3.json', {
      id: 'prt_3',
      type: 'tool',
      tool: 'read',
      state: { input: { path: 'file.ts' }, output: 'native output' },
    });
    const unknown = write('part/msg_2/prt_4.json', { id: 'prt_4', type: 'future', payload: 'keep me' });
    const original = readFileSync(session, 'utf8');
    expect(discoverOpencodeSessions()).toEqual([{ path: session, tool: 'opencode' }]);
    const lines = readOpencodeSession(session);
    expect(extractMessages(lines)[0]?.text).toBe('legacyquartz alpha');
    const source = JSON.parse(lines[0]!);
    expect(source.files.find((file: { path: string }) => file.path === session).content).toBe(original);
    expect(source.files.find((file: { path: string }) => file.path === unknown).content).toBe(
      readFileSync(unknown, 'utf8'),
    );
    expect((await searchSessions('legacyquartz'))[0]?.sessionId).toBe('ses_old');
    const before = opencodeStat(session);
    const timestamp = statSync(part);
    write('part/msg_1/prt_1.json', { id: 'prt_1', type: 'text', text: 'legacyquartz bravo' });
    utimesSync(part, timestamp.atime, timestamp.mtime);
    expect(opencodeStat(session)).not.toEqual(before);
    await refreshIndex();
    expect((await searchSessions('bravo'))[0]?.sessionId).toBe('ses_old');
    const archived = readSessionLines(session, 'opencode');
    expect(readFileSync(session, 'utf8')).toBe(original);
    writeFileSync(part, '{');
    expect(readSessionLines(session, 'opencode')).toEqual(archived);
    await refreshIndex();
    expect((await searchSessions('bravo'))[0]?.sessionId).toBe('ses_old');
    rmSync(storage, { recursive: true });
    closeDb();
    clearCache();
    expect((await searchSessions('bravo'))[0]?.sessionId).toBe('ses_old');
    expect(readSessionLines(session, 'opencode')).toEqual(archived);
  } finally {
    closeDb();
    closeOpencodeDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
