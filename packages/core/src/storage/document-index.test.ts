import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { indexDocuments } from './document-index';
import { type NativeDocument } from '../sources/native-memory';

test('native document projection updates text without duplicate search rows', () => {
  const db = new Database(':memory:');
  const document = (content: string): NativeDocument => ({
    harness: 'claude',
    kind: 'memory',
    path: '/native/MEMORY.md',
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    modifiedAt: '2026-09-08T10:00:00Z',
  });
  try {
    indexDocuments(db, [document('quartz retention')]);
    indexDocuments(db, [document('quartz retention')]);
    expect(db.query('SELECT count(*) AS count FROM native_document_fts').get()).toEqual({ count: 1 });
    db.run('DELETE FROM native_document_fts');
    indexDocuments(db, [document('quartz retention')]);
    expect(
      db.query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'quartz'").get(),
    ).toEqual({ count: 1 });
    db.run('INSERT INTO native_document_fts SELECT * FROM native_document_fts');
    indexDocuments(db, [document('quartz retention')]);
    expect(db.query('SELECT count(*) AS count FROM native_document_fts').get()).toEqual({ count: 1 });
    indexDocuments(db, [document('cobalt retention')]);
    expect(
      db.query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'quartz'").get(),
    ).toEqual({ count: 0 });
    expect(
      db.query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'cobalt'").get(),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
