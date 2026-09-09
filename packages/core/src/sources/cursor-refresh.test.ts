import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statSession } from '../session-io';
import { readCursorIde } from './cursor-ide';
import { readCursorStore } from './cursor-store';

test('Cursor change detection includes committed WAL records before checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-wal-'));
  const path = join(dir, 'store.db');
  const db = new Database(path);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)',
    );
    db.query('INSERT INTO meta VALUES (?, ?)').run('0', JSON.stringify({ latestRootBlobId: 'first' }));
    db.query('INSERT INTO blobs VALUES (?, ?)').run('first', Buffer.from('{"role":"user","content":"first"}'));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSession(path, 'cursor');
    const mainBefore = statSync(path);
    db.query('INSERT INTO blobs VALUES (?, ?)').run('second', Buffer.from('{"role":"user","content":"second"}'));
    db.query('UPDATE meta SET value = ?').run(JSON.stringify({ latestRootBlobId: 'second' }));
    expect(statSync(path).mtimeMs).toBe(mainBefore.mtimeMs);
    expect(statSession(path, 'cursor')).not.toEqual(before);
    expect(readCursorStore(path).events[0]?.text).toBe('second');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor IDE reads committed bubble updates without a composer timestamp change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-ide-wal-'));
  const path = join(dir, 'state.vscdb');
  const sessionPath = path + '/session';
  const db = new Database(path);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)',
    );
    const metadata = JSON.stringify({ lastUpdatedAt: 1700000000000, fullConversationHeadersOnly: [{ bubbleId: 'a' }] });
    db.run('INSERT INTO cursorDiskKV VALUES (?, ?)', ['composerData:session', metadata]);
    db.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [
      'bubbleId:session:a',
      JSON.stringify({ type: 2, text: 'first' }),
    ]);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = statSession(sessionPath, 'cursor');
    const mainBefore = statSync(path);
    db.run('UPDATE cursorDiskKV SET value = ? WHERE key = ?', [
      JSON.stringify({ type: 2, text: 'second' }),
      'bubbleId:session:a',
    ]);
    expect(statSync(path).mtimeMs).toBe(mainBefore.mtimeMs);
    expect(statSession(sessionPath, 'cursor')).not.toEqual(before);
    expect(readCursorIde(path, 'session')[0]?.events[0]?.text).toBe('second');
    expect(
      db.query<{ value: string }, []>("SELECT value FROM cursorDiskKV WHERE key = 'composerData:session'").get()?.value,
    ).toBe(metadata);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
