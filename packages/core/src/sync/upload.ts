import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../paths';
import { getArchiveDir, loadManifest } from '../vault/archive';
import { readArchivedDocuments } from '../storage/documents';
import { remoteConfig, remoteRequest, type RemoteConfig } from './client';
import { inventorySchema, snapshotHash, snapshotKey, type Snapshot } from './protocol';

interface Candidate {
  key: string;
  fingerprint: string;
  read: () => Snapshot;
}
function* snapshots(): Generator<Candidate> {
  const archive = getArchiveDir();
  for (const [sourcePath, entry] of Object.entries(loadManifest(archive))) {
    if (entry.tool === 'pi') continue;
    const metadata = {
      kind: 'session' as const,
      harness: entry.tool,
      sourcePath,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      modifiedAt: entry.archivedAt,
    };
    const stat = statSync(entry.vaultPath);
    yield {
      key: snapshotKey(metadata),
      fingerprint: JSON.stringify([metadata, stat.size, stat.mtimeMs, stat.ctimeMs]),
      read: () => ({ ...metadata, content: readFileSync(entry.vaultPath, 'utf8') }),
    };
  }
  for (const document of readArchivedDocuments(join(archive, 'native-documents'))) {
    const snapshot = {
      kind: document.kind,
      harness: document.harness,
      sourcePath: document.path,
      sessionId: '',
      cwd: '',
      modifiedAt: document.modifiedAt,
      content: document.content,
    };
    yield {
      key: snapshotKey(snapshot),
      fingerprint: JSON.stringify([
        snapshot.kind,
        snapshot.harness,
        snapshot.sourcePath,
        snapshot.modifiedAt,
        document.sha256,
      ]),
      read: () => snapshot,
    };
  }
}
/** The archive is the durable queue. Remote inventory makes retries and server restores idempotent. */
export async function syncArchive(config: RemoteConfig | null = remoteConfig()) {
  if (!config || config.identity.scope !== 'sync') return { uploaded: 0, unchanged: 0, configured: !!config };
  mkdirSync(getDataDir(), { recursive: true });
  const lock = new Database(join(getDataDir(), 'sync.sqlite'));
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    lock.close();
    if (!(error instanceof Error) || !/SQLITE_BUSY|database is locked/.test(error.message)) throw error;
    return { uploaded: 0, unchanged: 0, configured: true, busy: true };
  }
  let uploaded = 0,
    unchanged = 0;
  try {
    lock.exec(
      'CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, hash TEXT NOT NULL)',
    );
    const checkpoint = lock.query<{ fingerprint: string; hash: string }, [string]>(
      'SELECT fingerprint,hash FROM checkpoints WHERE key=?',
    );
    const inventory = new Map(
      inventorySchema.parse(await remoteRequest(config, '/v1/inventory')).map((item) => [item.key, item.hash]),
    );
    for (const candidate of snapshots()) {
      const { key, fingerprint } = candidate;
      const previous = checkpoint.get(key);
      // A replaced archive file changes its stat fingerprint even before the manifest is saved.
      if (previous?.fingerprint === fingerprint && inventory.get(key) === previous.hash) {
        unchanged++;
        continue;
      }
      const snapshot = candidate.read(),
        hash = snapshotHash(snapshot);
      if (inventory.get(key) === hash) {
        unchanged++;
      } else {
        await remoteRequest(config, '/v1/snapshots', { snapshot, previousHash: inventory.get(key) ?? null });
        uploaded++;
      }
      lock.run('INSERT OR REPLACE INTO checkpoints(key,fingerprint,hash) VALUES (?,?,?)', [key, fingerprint, hash]);
    }
    lock.exec('COMMIT');
    return { uploaded, unchanged, configured: true };
  } finally {
    lock.close();
  }
}
