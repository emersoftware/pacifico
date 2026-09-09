import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCursorStore } from './cursor-store';

test('Cursor reads graph order rather than insertion order and preserves the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-'));
  const path = join(dir, 'store.db');
  const db = new Database(path);
  try {
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)',
    );
    const root = 'aa'.repeat(32),
      first = 'bb'.repeat(32),
      second = 'cc'.repeat(32);
    db.query('INSERT INTO meta VALUES (?, ?)').run(
      '0',
      Buffer.from(JSON.stringify({ latestRootBlobId: root, agentId: 'session' })).toString('hex'),
    );
    const insert = db.query('INSERT INTO blobs VALUES (?, ?)');
    insert.run(second, Buffer.from(JSON.stringify({ role: 'assistant', content: 'second' })));
    insert.run(first, Buffer.from(JSON.stringify({ role: 'user', content: 'first' })));
    insert.run(
      root,
      Buffer.concat([
        Buffer.from([10, 32]),
        Buffer.from(first, 'hex'),
        Buffer.from([18, 32]),
        Buffer.from(second, 'hex'),
        Buffer.from([10, 32]),
        Buffer.from(root, 'hex'),
      ]),
    );
    const before = readFileSync(path);
    const result = readCursorStore(path);
    expect(result.events.map((m) => m.text)).toEqual(['first', 'second']);
    expect(result.incomplete).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    db.exec('PRAGMA journal_mode=WAL');
    insert.run('dd'.repeat(32), Buffer.from('{"role":"user","content":"committed WAL"}'));
    db.query('UPDATE meta SET value = ?').run(JSON.stringify({ latestRootBlobId: 'dd'.repeat(32) }));
    expect(readCursorStore(path).events[0]?.text).toBe('committed WAL');
    db.query('UPDATE meta SET value = ?').run(JSON.stringify({ latestRootBlobId: 'ee'.repeat(32) }));
    expect(readCursorStore(path).incomplete).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
