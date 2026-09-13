import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { connectClaude } from './channel';

test('externally loaded Claude channel receives and correlates replies without starting Claude', async () => {
  const id = randomUUID();
  const client = new Client({ name: 'external-claude-fixture', version: '1' });
  let notify!: (value: any) => void;
  const events: any[] = [];
  client.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }),
    (event) => {
      events.push(event);
      notify?.(event);
    },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.env.PACIFICO_TEST_CLI_BINARY ?? process.execPath,
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      args: [
        ...(process.env.PACIFICO_TEST_CLI_BINARY
          ? []
          : [resolve(import.meta.dir, '../../../../apps/cli/src/index.ts')]),
        'channel',
        id,
      ],
    }),
  );
  const adapter = connectClaude(id, () => {});
  try {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
    // MCP initialization precedes socket bind.
    await Bun.sleep(100);
    const eventPromise = new Promise<any>((resolve) => {
      notify = resolve;
    });
    const result = adapter.send('Use the context already in this terminal.');
    const event = await eventPromise;
    expect(event.params.content).toBe('Use the context already in this terminal.');
    const bad = await client
      .callTool({ name: 'reply', arguments: { request_id: randomUUID(), text: 'Wrong' } })
      .catch(() => ({ isError: true }));
    expect(bad.isError).toBe(true);
    await client.callTool({
      name: 'reply',
      arguments: { request_id: event.params.meta.request_id, text: 'Existing context preserved.' },
    });
    expect(await result).toBe('Existing context preserved.');
    expect(events).toHaveLength(1);
    expect(adapter.id).toBe(id);
  } finally {
    adapter.close();
    await client.close();
  }
});
