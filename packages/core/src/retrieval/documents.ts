import { ensureIndexFresh } from '../ingestion/sessions';
import { getDb } from '../storage/index';

export async function searchNativeDocuments(query: string, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be between 1 and 50');
  if (!query.trim() || query.length > 4000) throw new Error('Query must contain 1 to 4000 characters');
  await ensureIndexFresh();
  const match = query
    .trim()
    .split(/\s+/)
    .map((word) => '"' + word.replaceAll('"', '""') + '"')
    .join(' AND ');
  return getDb()
    .query(
      `SELECT d.id, d.harness, d.kind, d.path, d.modified_at AS modifiedAt,
    snippet(native_document_fts, 1, '', '', ' … ', 32) AS snippet
    FROM native_document_fts JOIN native_documents d ON d.id = native_document_fts.id
    WHERE native_document_fts MATCH ? ORDER BY rank, d.id LIMIT ?`,
    )
    .all(match, limit);
}

export async function readNativeDocument(id: string, offset = 0, limit = 12000) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid document id');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid document offset');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('Limit must be between 1 and 20000');
  await ensureIndexFresh();
  const row = getDb()
    .query(
      `SELECT id, harness, kind, path, content, modified_at AS modifiedAt
    FROM native_documents WHERE id = ?`,
    )
    .get(id) as { id: string; harness: string; kind: string; path: string; content: string; modifiedAt: string } | null;
  if (!row) return null;
  return {
    ...row,
    content: row.content.slice(offset, offset + limit),
    offset,
    total: row.content.length,
    truncated: offset + limit < row.content.length,
  };
}
