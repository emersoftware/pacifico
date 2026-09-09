import { searchSessions, closeDb, clearCache } from '../cache';
import { readSessionLines } from '../session-io';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { antigravityGitVersion, readAntigravityGit } from './antigravity-git';
import { mergeAntigravityTranscripts } from './antigravity-transcript';
import { readImportedSession } from '../ingestion/imported-session';
import { discoverNativeSessions } from './discovery';
import { statSession } from '../session-io';

test('native Git history restores removed steps and retains changed variants without checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-ag-git-'));
  const conversation = join(root, 'antigravity/brain/session');
  const transcript = join(conversation, '.system_generated/logs/transcript.jsonl');
  const full = transcript.replace('transcript.jsonl', 'transcript_full.jsonl');
  const environment = {
    SESSIONS_HOME: root,
    SESSIONS_NATIVE_HOME: root,
    SESSIONS_ANTIGRAVITY_DIR: root,
    SESSIONS_CLAUDE_DIR: join(root, 'claude'),
    SESSIONS_CODEX_DIR: join(root, 'codex'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(root, 'archived'),
    SESSIONS_CURSOR_DIR: join(root, 'cursor'),
    SESSIONS_CURSOR_IDE_DIR: join(root, 'cursor-ide'),
    SESSIONS_OPENCODE_DB: join(root, 'opencode.db'),
    SESSIONS_CACHE_DIR: join(root, 'cache'),
    SESSIONS_ARCHIVE_DIR: join(root, 'archive'),
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  closeDb();
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', conversation, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  const step = (index: number, content: string) =>
    JSON.stringify({
      step_index: index,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content,
      native: { retained: true },
    }) + '\n';
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Native snapshot');
  };
  try {
    mkdirSync(dirname(transcript), { recursive: true });
    expect(antigravityGitVersion(transcript)).toBeNull();
    git('init', '-q');
    writeFileSync(full, step(0, 'early history') + step(1, 'original answer'));
    commit();
    const version = antigravityGitVersion(transcript);
    writeFileSync(full, step(1, 'updated answer'));
    commit();
    expect(antigravityGitVersion(transcript)).not.toBe(version);
    writeFileSync(transcript, step(2, 'current message'));
    const status = git('status', '--porcelain');
    const history = readAntigravityGit(transcript);
    expect(history).toHaveLength(2);
    const merged = mergeAntigravityTranscripts(readFileSync(transcript, 'utf8'), readFileSync(full, 'utf8'), history);
    expect(merged.events.map((event) => event.text)).toEqual(['early history', 'updated answer', 'current message']);
    expect(merged.events[1]?.variants?.map((variant) => variant.record.content)).toContain('original answer');
    expect(merged.events[0]?.variants?.[0]?.source).toMatch(/^git:[0-9a-f]+:/);
    expect(git('status', '--porcelain')).toBe(status);
    rmSync(transcript);
    rmSync(full);
    expect((await discoverNativeSessions()).some((source) => source.path === transcript)).toBe(true);
    expect(statSession(transcript, 'antigravity')).not.toBeNull();
    const restored = readImportedSession(transcript, 'antigravity').map((line) => JSON.parse(line));
    expect(restored.filter((record) => record.type === 'message').map((record) => record.source.raw.content)).toEqual([
      'early history',
      'updated answer',
    ]);
    expect((await searchSessions('early history'))[0]?.sessionId).toBe('session');
    const archived = readSessionLines(transcript, 'antigravity');
    rmSync(conversation, { recursive: true });
    closeDb();
    clearCache();
    expect((await searchSessions('early history'))[0]?.sessionId).toBe('session');
    expect(readSessionLines(transcript, 'antigravity')).toEqual(archived);
  } finally {
    closeDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
