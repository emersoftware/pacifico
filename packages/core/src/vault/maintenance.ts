import { readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireRefreshLock } from '../refresh-lock';
import { loadManifest, saveManifest, migrateArchive, type Manifest } from './archive';

/** Only managed content-addressed objects are collectible. Legacy orphans remain evidence. */
export function collectArchiveObjects(dir: string, manifest: Manifest): number {
  const folder = join(dir, 'objects');
  if (!existsSync(folder)) return 0;
  const referenced = new Set(Object.values(manifest).map((entry) => entry.vaultPath));
  let removed = 0;
  for (const name of readdirSync(folder)) {
    if (/^[a-f0-9]{64}\.jsonl\.gz(?:\.tmp-\d+|\.summary\.json\.tmp)$/.test(name)) {
      const temp = join(folder, name);
      if (Date.now() - statSync(temp).mtimeMs > 60_000) rmSync(temp, { force: true });
      continue;
    }
    if (!/^[a-f0-9]{64}\.jsonl\.gz$/.test(name)) continue;
    const path = join(folder, name);
    // Grace period protects readers that opened the previous manifest before a refresh.
    if (referenced.has(path) || Date.now() - statSync(path).mtimeMs < 60_000) continue;
    rmSync(path);
    rmSync(path + '.summary.json', { force: true });
    removed++;
  }
  return removed;
}

/** Explicit maintenance migrates in small transactions, yielding to regular ingestion. */
export async function compactArchive(dir: string, apply: boolean) {
  const initial = loadManifest(dir, true);
  const pending = Object.values(initial).filter((entry) => entry.storageVersion !== 1 && entry.tool !== 'pi');
  if (!apply) return { pending: pending.length, migrated: 0, removedObjects: 0, dryRun: true };
  let migrated = 0,
    removedObjects = 0;
  while (true) {
    const release = await acquireRefreshLock(dir);
    let count: number;
    try {
      const manifest = loadManifest(dir, true);
      count = migrateArchive(dir, manifest, 1);
      saveManifest(dir, manifest);
      removedObjects += collectArchiveObjects(dir, manifest);
    } finally {
      release();
    }
    migrated += count;
    if (!count) break;
    if (migrated % 25 === 0) {
      // Long one-shot migrations should release transcript trees between batches.
      Bun.gc(true);
      process.stderr.write(`Compacted ${migrated}/${pending.length} archive entries\n`);
    }
    await Bun.sleep(0);
  }
  return { pending: pending.length, migrated, removedObjects, dryRun: false };
}
