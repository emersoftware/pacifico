import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeUsage, queryUsage, type UsageRecord } from '../usage';

const root = mkdtempSync(join(tmpdir(), 'pacifico-benchmark-'));
const original = process.env.SESSIONS_DATA_DIR;
process.env.SESSIONS_DATA_DIR = root;
try {
  const records: UsageRecord[] = Array.from({ length: 10000 }, (_, index) => ({
    tool: index % 2 ? 'codex' : 'claude-code',
    model: `model-${index % 4}`,
    sessionId: `session-${index % 100}`,
    timestamp: new Date(Date.UTC(2026, 8, 1 + (index % 9), 12)).toISOString(),
    dedupKey: String(index),
    tokens: { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 0 },
  }));
  const start = performance.now();
  const inserted = storeUsage(records);
  const afterInsert = performance.now();
  const repeated = storeUsage(records);
  const afterRepeat = performance.now();
  const report = queryUsage({ now: new Date('2026-09-10T12:00:00Z'), timezone: 'UTC', group: 'model' });
  const end = performance.now();
  if (inserted !== 10000 || repeated !== 0 || report.periods.all!.tokens !== 31_000_000)
    throw new Error('Benchmark correctness invariant failed.');
  console.log(
    JSON.stringify(
      {
        fixtureEvents: records.length,
        inserted,
        repeated,
        insertMs: afterInsert - start,
        repeatMs: afterRepeat - afterInsert,
        queryMs: end - afterRepeat,
        tokens: report.periods.all!.tokens,
        unit: 'synthetic measured pipeline, not provider data',
      },
      null,
      2,
    ),
  );
} finally {
  if (original === undefined) delete process.env.SESSIONS_DATA_DIR;
  else process.env.SESSIONS_DATA_DIR = original;
  rmSync(root, { recursive: true, force: true });
}
