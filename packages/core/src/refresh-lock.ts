import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Serialize a complete archive/index refresh across processes sharing a vault.
 * SQLite releases ownership even after SIGKILL, so there are no PID files or
 * stale-lock deletion races. This database is separate from the rebuildable index.
 * The caller must release in finally; a contended acquisition yields the event loop.
 */
export async function acquireRefreshLock(archiveDir: string): Promise<() => void> {
  mkdirSync(archiveDir, { recursive: true });
  const db = new Database(join(archiveDir, '.refresh-lock.sqlite'));
  db.exec('PRAGMA busy_timeout=0');
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return () => db.close();
    } catch (error) {
      const busy = error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message);
      if (!busy || Date.now() >= deadline) {
        db.close();
        throw error;
      }
      await Bun.sleep(100);
    }
  }
}
