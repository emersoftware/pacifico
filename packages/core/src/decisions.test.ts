import { test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeIndex } from './storage/index';
import { listDecisions, saveDecision, exportDecisions } from './decisions';

let root: string, path: string;
let original: { data?: string; cache?: string };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pacifico-decisions-'));
  original = { data: process.env.SESSIONS_DATA_DIR, cache: process.env.SESSIONS_CACHE_DIR };
  process.env.SESSIONS_DATA_DIR = join(root, 'data');
  process.env.SESSIONS_CACHE_DIR = join(root, 'cache');
  closeIndex();
  path = join(root, 'session.jsonl');
  writeFileSync(
    path,
    [
      { type: 'assistant', message: { role: 'assistant', content: 'Use SQLite?' } },
      { type: 'user', message: { role: 'user', content: 'Yes, use SQLite.' } },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  getDb().run(
    `INSERT INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, first_prompt)
    VALUES (?, 1, 1, ?, 'claude', 'test-session', '2026-09-09', 'Database choice')`,
    [path, root],
  );
});
afterEach(() => {
  closeIndex();
  if (original.data === undefined) delete process.env.SESSIONS_DATA_DIR;
  else process.env.SESSIONS_DATA_DIR = original.data;
  if (original.cache === undefined) delete process.env.SESSIONS_CACHE_DIR;
  else process.env.SESSIONS_CACHE_DIR = original.cache;
  rmSync(root, { recursive: true, force: true });
});
function input() {
  return {
    project: root,
    title: 'Storage',
    decision: 'Use SQLite.',
    decidedAt: '2026-09-09',
    evidence: [{ filePath: path, messageIndex: 1, quote: 'Yes, use SQLite.' }],
  };
}
test('verified decisions are idempotent and survive deletion of transcripts and index', () => {
  const saved = saveDecision(input());
  expect(saveDecision(input()).id).toBe(saved.id);
  expect(saved.evidence[0]!.role).toBe('user');
  rmSync(path);
  closeIndex();
  rmSync(join(root, 'cache'), { recursive: true });
  expect(listDecisions(root)).toHaveLength(1);
  const files = exportDecisions(root, join(root, 'adr'));
  expect(readFileSync(files[0]!, 'utf8')).toContain('Yes, use SQLite.');
  expect(() => exportDecisions(root, join(root, 'adr'))).toThrow();
});
test('rejects invented evidence, assistant-only proposals, and another project', () => {
  expect(() =>
    saveDecision({ ...input(), evidence: [{ filePath: path, messageIndex: 1, quote: 'Use Postgres.' }] }),
  ).toThrow('quote');
  expect(() =>
    saveDecision({ ...input(), evidence: [{ filePath: path, messageIndex: 0, quote: 'Use SQLite?' }] }),
  ).toThrow('user');
  expect(() => saveDecision({ ...input(), project: root + '-other' })).toThrow('project');
});
test('replacements preserve earlier decisions and prevent competing successors', () => {
  const first = saveDecision(input());
  const second = saveDecision({
    ...input(),
    title: 'Reconfirmed storage',
    decidedAt: '2026-09-10',
    supersedes: first.id,
  });
  expect(listDecisions(root).find((d) => d.id === first.id)?.status).toBe('superseded');
  expect(listDecisions(root).find((d) => d.id === second.id)?.status).toBe('accepted');
  expect(() => saveDecision({ ...input(), title: 'Competing revision', supersedes: first.id })).toThrow();
});

test('reading decisions does not create storage before the first explicit save', () => {
  const databasePath = join(root, 'data', 'decisions.sqlite');
  expect(listDecisions(root)).toEqual([]);
  expect(existsSync(databasePath)).toBe(false);
  saveDecision(input());
  expect(existsSync(databasePath)).toBe(true);
  expect(listDecisions(root)).toHaveLength(1);
});
