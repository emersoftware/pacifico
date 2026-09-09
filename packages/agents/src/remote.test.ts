import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeTool, response } from './remote';

test('invalid remote configuration preserves local queries and rejects explicitly remote reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-remote-'));
  const previous = process.env.SESSIONS_DATA_DIR;
  process.env.SESSIONS_DATA_DIR = root;
  try {
    writeFileSync(join(root, 'remote.json'), '{invalid');
    const local = async () =>
      response({ result: { mode: 'ranked', data: { results: [{ title: 'local evidence' }], count: 1 } } });
    const combined = await routeTool('search_sessions', { query: 'evidence' }, local);
    expect(combined.isError).not.toBe(true);
    expect(combined.structuredContent?.remote).toEqual({
      available: false,
      error: 'Remote configuration is invalid; results contain local data only.',
    });
    expect(combined.content[0]?.text).toContain('local evidence');
    expect(await routeTool('search_sessions', { scope: 'local' }, local)).toEqual(await local());
    const read = async () =>
      response({ result: { mode: 'messages', data: { total: 0, offset: 0, returned: 0, messages: [] } } });
    expect(await routeTool('read_session', { filePath: '/local.jsonl' }, read)).toEqual(await read());
    expect((await routeTool('search_sessions', { scope: 'remote' }, local)).isError).toBe(true);
    expect((await routeTool('read_session', { filePath: 'pacifico://remote' }, local)).isError).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SESSIONS_DATA_DIR;
    else process.env.SESSIONS_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
