import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRefreshLock } from './refresh-lock';

test('a competing refresh waits until the first owner releases the vault', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacifico-lock-'));
  const release = await acquireRefreshLock(directory);
  let entered = false;
  const second = acquireRefreshLock(directory).then((unlock) => {
    entered = true;
    unlock();
  });
  try {
    await Bun.sleep(150);
    expect(entered).toBe(false);
    release();
    await second;
    expect(entered).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a killed owner cannot leave a stale lock that blocks the next process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacifico-lock-crash-'));
  const modulePath = join(import.meta.dir, 'refresh-lock.ts');
  const source = `import { acquireRefreshLock } from ${JSON.stringify(modulePath)}; await acquireRefreshLock(${JSON.stringify(directory)}); console.log('locked'); await Bun.sleep(60000);`;
  const worker = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe' });
  try {
    const reader = worker.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
    reader.releaseLock();
    worker.kill('SIGKILL');
    await worker.exited;
    const release = await acquireRefreshLock(directory);
    release();
  } finally {
    worker.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
