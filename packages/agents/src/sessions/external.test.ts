import { Database } from 'bun:sqlite';
import { SessionService } from './service';
import { test, expect } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import websocket from 'websocket-driver';
import { connectCodex } from './adapters';

test('send attaches to an external Codex session and ignores another client turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacifico-external-'));
  const path = join(directory, 'server.sock');
  let busy = false;
  const methods: string[] = [];
  const server = createServer((socket) => {
    const driver = websocket.server();
    socket.on('error', () => {});
    socket.pipe(driver.io).pipe(socket);
    driver.on('connect', () => driver.start());
    driver.on('message', ({ data }) => {
      const event = JSON.parse(data);
      methods.push(event.method);
      const send = (value: unknown) => driver.text(JSON.stringify(value));
      const reply = (result: unknown) => send({ id: event.id, result });
      if (event.method === 'initialize') reply({});
      if (event.method === 'thread/loaded/list') reply({ data: ['external-session'] });
      if (event.method === 'thread/read')
        reply({ thread: { id: 'external-session', status: { type: busy ? 'active' : 'idle' } } });
      if (event.method === 'thread/resume') {
        expect(event.params).toEqual({ threadId: 'external-session' });
        reply({ thread: { id: 'external-session' } });
      }
      if (event.method === 'turn/start') {
        // Events can arrive before acknowledgement. Only the returned turn ID belongs to this request.
        send({
          method: 'turn/completed',
          params: { threadId: 'external-session', turn: { id: 'other-client', status: 'completed' } },
        });
        send({
          method: 'item/completed',
          params: {
            threadId: 'external-session',
            turnId: 'ours',
            item: { type: 'agentMessage', text: 'Context from the original client.' },
          },
        });
        reply({ turn: { id: 'ours' } });
        send({
          method: 'turn/completed',
          params: { threadId: 'external-session', turn: { id: 'ours', status: 'completed' } },
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const adapter = await connectCodex('external-session', () => {}, path);
    try {
      expect(await adapter.send('Continue')).toBe('Context from the original client.');
      expect(adapter.id).toBe('external-session');
      busy = true;
      await expect(adapter.send('Do not interrupt')).rejects.toThrow('not idle');
      expect(methods.filter((method) => method === 'turn/start')).toHaveLength(1);
      expect(methods).not.toContain('thread/start');
      expect(methods).not.toContain('thread/fork');
      await expect(connectCodex('missing', () => {}, path)).rejects.toThrow('not loaded');
    } finally {
      adapter.close();
    }
    busy = false;
    const db = new Database(':memory:');
    const service = new SessionService(db, async () => {
      throw new Error('Must not start a harness for send.');
    });
    try {
      const receipt = await service.sendExisting('codex:external-session', 'Continue from the CLI service', path);
      for (let i = 0; i < 100 && service.read(receipt.request).status === 'running'; i++) await Bun.sleep(10);
      expect(service.read(receipt.request).status).toBe('completed');
      expect(service.read(receipt.request).text).toBe('Context from the original client.');
      expect(service.list()[0]?.write).toBeNull();
    } finally {
      service.closeAll();
      db.close();
    }
    expect(server.listening).toBe(true);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
