import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type NativeDocument } from '../sources/native-memory';

const documentSchema = z.object({
  harness: z.enum(['claude', 'codex', 'cursor', 'antigravity', 'opencode']),
  kind: z.enum(['memory', 'instructions', 'artifact']),
  path: z.string(),
  content: z.string(),
  sha256: z.string(),
  modifiedAt: z.string(),
});

function documentId(document: Pick<NativeDocument, 'harness' | 'path'>): string {
  return createHash('sha256')
    .update(document.harness + '\0' + document.path)
    .digest('hex');
}

/** Stores source copies, never synthesized memories. Each source has a stable archive identity. */
export function archiveDocuments(directory: string, documents: NativeDocument[]): void {
  mkdirSync(directory, { recursive: true });
  for (const document of documents) {
    const id = documentId(document);
    const path = join(directory, id + '.json');
    const body = JSON.stringify(document);
    try {
      if (readFileSync(path, 'utf8') === body) continue;
    } catch {}
    const temporary = path + `.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, body);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

/** Missing native sources do not remove their archived copies. Corrupt copies are reported. */
export function readArchivedDocuments(directory: string): NativeDocument[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
    .sort()
    .map((file) => {
      const document = documentSchema.parse(JSON.parse(readFileSync(join(directory, file), 'utf8')));
      if (documentId(document) + '.json' !== file) throw new Error(`Archived document identity mismatch: ${file}`);
      const hash = createHash('sha256').update(document.content).digest('hex');
      if (hash !== document.sha256) throw new Error(`Archived document checksum mismatch: ${file}`);
      return document;
    });
}
