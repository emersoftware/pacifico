import { type Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { type NativeDocument } from '../sources/native-memory';

/** Rebuildable search projection of archived native documents. */
export function indexDocuments(db: Database, documents: NativeDocument[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS native_documents (
    id TEXT PRIMARY KEY, harness TEXT NOT NULL, kind TEXT NOT NULL,
    path TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, modified_at TEXT NOT NULL
  ); CREATE VIRTUAL TABLE IF NOT EXISTS native_document_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');`);
  db.transaction(() => {
    const existing = db.query('SELECT sha256 FROM native_documents WHERE id = ?');
    const indexed = new Map(
      db
        .query<{ id: string; count: number }, []>('SELECT id, count(*) AS count FROM native_document_fts GROUP BY id')
        .all()
        .map((row) => [row.id, row.count]),
    );
    const put = db.query('INSERT OR REPLACE INTO native_documents VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const document of documents) {
      const id = createHash('sha256')
        .update(document.harness + '\0' + document.path)
        .digest('hex');
      const old = existing.get(id) as { sha256: string } | null;
      put.run(
        id,
        document.harness,
        document.kind,
        document.path,
        document.content,
        document.sha256,
        document.modifiedAt,
      );
      if (old?.sha256 === document.sha256 && indexed.get(id) === 1) continue;
      db.query('DELETE FROM native_document_fts WHERE id = ?').run(id);
      db.query('INSERT INTO native_document_fts VALUES (?, ?)').run(id, document.content);
    }
  })();
}
