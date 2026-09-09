import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readImportedSession } from './imported-session';

test('Antigravity retains an older native variant when the same step is rewritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-step-variants-'));
  try {
    const path = join(root, 'antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    const old = { step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'complete original output' };
    writeFileSync(path, JSON.stringify(old));
    const previous = readImportedSession(path, 'antigravity');
    writeFileSync(path, JSON.stringify({ ...old, content: 'shortened' }));
    const updated = readImportedSession(path, 'antigravity', previous);
    const step = JSON.parse(updated.find((line) => JSON.parse(line).type === 'message')!);
    expect(
      step.source.variants.some((v: { record: unknown }) => JSON.stringify(v.record) === JSON.stringify(old)),
    ).toBe(true);
    expect(readImportedSession(path, 'antigravity', updated)).toEqual(updated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
