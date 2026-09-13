import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionService, type SessionFactory } from './service';

describe('live session requests', () => {
  test('send keeps the same native session and rejects concurrent or unknown destinations', async () => {
    const db = new Database(':memory:');
    const messages: string[] = [];
    let finish: (value: string) => void = () => {};
    let launches = 0;
    const factory: SessionFactory = async (_h, _cwd, onExit) => {
      launches++;
      return {
        id: 'native-1',
        send(message) {
          messages.push(message);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        close: onExit,
      };
    };
    const service = new SessionService(db, factory);
    const first = await service.start('claude', process.cwd(), 'Remember blue');
    expect(first.session).toBe('claude:native-1');
    expect(() => service.send(first.session, 'Too soon')).toThrow('busy');
    expect(() => service.close(first.session)).toThrow('busy');
    expect(() => service.closeAll()).toThrow('busy');
    expect(() => service.send('claude:missing', 'Hello')).toThrow('not connected');
    finish('Remembered');
    await Bun.sleep(0);
    expect(service.read(first.request).text).toBe('Remembered');
    const second = service.send(first.session, 'Which color?');
    finish('blue');
    await Bun.sleep(0);
    expect(service.read(second.request).text).toBe('blue');
    expect(service.read(first.request).text).toBe('Remembered');
    expect(launches).toBe(1);
    expect(messages).toEqual(['Remember blue', 'Which color?']);
    service.close(first.session);
    expect(() => service.send(first.session, 'After close')).toThrow('not connected');
    db.close();
  });

  test('restart preserves results and marks unfinished requests unknown without replay', () => {
    const db = new Database(':memory:');
    new SessionService(db);
    db.query('INSERT INTO requests VALUES (?, ?)').run(
      'pending',
      JSON.stringify({ request: 'pending', session: 'codex:1', status: 'running', text: '' }),
    );
    db.query('INSERT INTO requests VALUES (?, ?)').run(
      'done',
      JSON.stringify({ request: 'done', session: 'codex:1', status: 'completed', text: 'answer' }),
    );
    const restarted = new SessionService(db);
    expect(restarted.read('pending').status).toBe('unknown');
    expect(restarted.read('done').text).toBe('answer');
    expect(restarted.list()).toEqual([]);
    db.close();
  });

  test('invalid input never launches a harness and failures remain request-scoped', async () => {
    const db = new Database(':memory:');
    let launches = 0;
    const service = new SessionService(db, async (_h, _cwd, onExit) => {
      launches++;
      return {
        id: '1',
        send: async () => {
          throw new Error('Authentication failed');
        },
        close: onExit,
      };
    });
    await expect(service.start('codex', process.cwd(), '  ')).rejects.toThrow('Message');
    await expect(service.start('codex', '.', 'Hello')).rejects.toThrow('absolute');
    await expect(service.start('codex', '/no-such-pacifico-test-directory', 'Hello')).rejects.toThrow();
    expect(launches).toBe(0);
    const request = await service.start('codex', process.cwd(), 'Hello');
    await Bun.sleep(0);
    expect(service.read(request.request).error).toBe('Authentication failed');
    expect(service.list()[0]?.status).toBe('ready');
    service.closeAll();
    db.close();
  });
});
