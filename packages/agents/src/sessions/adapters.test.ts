import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSession } from './adapters';

test('official transports retain conversation context and handle protocol failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-protocol-'));
  const script = join(root, 'harness.ts');
  writeFileSync(
    script,
    `
    import { createInterface } from 'node:readline';
    let previous = '';
    const output = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      const input = JSON.parse(line);
      if (input.method === 'initialize') output({ id: input.id, result: {} });
      if (input.method === 'thread/start') output({ id: input.id, result: { thread: { id: 'native-codex' } } });
      if (input.method === 'turn/start') {
        const message = input.params.input[0].text;
        if (message === 'crash') { process.exit(9); }
        output({ id: input.id, result: { turn: { id: 'turn-1' } } });
        output({ method: 'item/completed', params: { threadId: 'unrelated', item: { type: 'agentMessage', text: 'WRONG' } } });
        output({ method: 'item/completed', params: { threadId: 'native-codex', turnId: 'turn-1', item: { type: 'agentMessage', text: previous || message } } });
        output({ method: 'turn/completed', params: { threadId: 'native-codex', turn: { id: 'turn-1', status: 'completed' } } });
        previous = message;
      }
      if (input.type === 'user') {
        const message = input.message.content;
        if (message === 'crash') { process.exit(9); }
        output({ type: 'result', subtype: 'success', session_id: input.session_id, result: previous || message });
        previous = message;
      }
    });
  `,
  );
  try {
    for (const harness of ['claude', 'codex'] as const) {
      let exited = false;
      const session = await openSession(
        harness,
        root,
        () => {
          exited = true;
        },
        { [harness]: [process.execPath, script] },
      );
      try {
        const id = session.id;
        expect(await session.send('a secret color')).toBe('a secret color');
        expect(await session.send('What was it?')).toBe('a secret color');
        expect(session.id).toBe(id);
        await expect(session.send('crash')).rejects.toThrow('Harness exited');
        expect(exited).toBe(true);
        await expect(session.send('after exit')).rejects.toThrow();
      } finally {
        session.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
