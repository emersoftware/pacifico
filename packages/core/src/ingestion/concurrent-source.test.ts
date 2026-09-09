import { test, expect, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sessionIo from '../session-io';
import { refreshIndex, closeDb } from './sessions';
import { loadManifest, saveManifest } from '../vault/archive';

test('a source changed during reading keeps its previous index and archive until retry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-concurrent-'));
  const env = {
    SESSIONS_HOME: home,
    SESSIONS_NATIVE_HOME: home,
    SESSIONS_CACHE_DIR: join(home, 'cache'),
    SESSIONS_ARCHIVE_DIR: join(home, 'archive'),
    SESSIONS_CLAUDE_DIR: join(home, 'claude'),
    SESSIONS_CODEX_DIR: join(home, 'codex'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(home, 'codex-archive'),
    SESSIONS_CURSOR_DIR: join(home, 'cursor'),
    SESSIONS_ANTIGRAVITY_DIR: join(home, 'gemini'),
    SESSIONS_OPENCODE_DB: join(home, 'missing.db'),
  };
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  closeDb();
  let restore = () => {};
  try {
    const project = join(env.SESSIONS_CLAUDE_DIR, 'project');
    mkdirSync(project, { recursive: true });
    const path = join(project, 'session.jsonl');
    const content = (text: string) =>
      JSON.stringify({ type: 'user', sessionId: 'native', cwd: '/project', message: { content: text } });
    const original = content('originalquartz');
    writeFileSync(path, original);
    await refreshIndex();
    // Simulate an older index that has no corresponding archive manifest.
    saveManifest(env.SESSIONS_ARCHIVE_DIR, {});
    const oldIndex = new Database(join(env.SESSIONS_CACHE_DIR, 'index.db'));
    oldIndex
      .query('UPDATE sessions SET session_id = ?, first_prompt = ? WHERE file_path = ?')
      .run('stale-id', 'stale prompt', path);
    oldIndex.close();
    await refreshIndex();
    expect(loadManifest(env.SESSIONS_ARCHIVE_DIR)[path]?.sessionId).toBe('native');
    const repairedIndex = new Database(join(env.SESSIONS_CACHE_DIR, 'index.db'), { readonly: true });
    try {
      expect(
        repairedIndex.query('SELECT session_id, first_prompt FROM sessions WHERE file_path = ?').get(path),
      ).toEqual({ session_id: 'native', first_prompt: 'originalquartz' });
    } finally {
      repairedIndex.close();
    }
    writeFileSync(path, content('intermediatequartz longer'));
    const stat = sessionIo.statSession;
    let calls = 0;
    const spy = spyOn(sessionIo, 'statSession').mockImplementation((file, tool) => {
      // Candidate scan, pre-read stat, then post-read verification.
      if (file === path && ++calls === 3) writeFileSync(path, content('finalquartz even longer content'));
      return stat(file, tool);
    });
    restore = () => spy.mockRestore();
    await refreshIndex();
    restore();
    expect(calls).toBeGreaterThanOrEqual(3);
    const archived = loadManifest(env.SESSIONS_ARCHIVE_DIR)[path]!;
    expect(readFileSync(archived.vaultPath, 'utf8')).toBe(original);
    const db = new Database(join(env.SESSIONS_CACHE_DIR, 'index.db'), { readonly: true });
    try {
      expect(db.query('SELECT first_prompt FROM sessions WHERE file_path = ?').get(path)).toEqual({
        first_prompt: 'originalquartz',
      });
    } finally {
      db.close();
    }
    await refreshIndex();
    expect(readFileSync(archived.vaultPath, 'utf8')).toContain('finalquartz');
  } finally {
    restore();
    closeDb();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
