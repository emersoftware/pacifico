import { createServer, createConnection } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { getDataDir } from '@pacifico/core/paths';
import { SessionService } from './service';

const Message = z.string().trim().min(1).max(64000);
export const Request = z.discriminatedUnion('method', [
  z.object({ method: z.literal('list') }).strict(),
  z.object({ method: z.literal('stop') }).strict(),
  z
    .object({
      method: z.literal('start'),
      harness: z.enum(['claude', 'codex']),
      project: z.string().min(1),
      message: Message,
      write: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ method: z.literal('send'), session: z.string(), message: Message, socket: z.string().optional() })
    .strict(),
  z.object({ method: z.literal('result'), request: z.string().uuid() }).strict(),
  z.object({ method: z.literal('close'), session: z.string() }).strict(),
]);
export type ControlRequest = z.input<typeof Request>;

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error(`Unsafe runtime directory: ${path}`);
  chmodSync(path, 0o700);
}
export function socketPath(): string {
  const root = `/tmp/pacifico-${process.getuid?.()}`;
  privateDirectory(root);
  return join(root, createHash('sha256').update(getDataDir()).digest('hex').slice(0, 20) + '.sock');
}

/** One bounded request per local connection; never retries a possibly delivered mutation. */
export function callControl(request: ControlRequest): Promise<any> {
  const payload = JSON.stringify(Request.parse(request)) + '\n';
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let data = '';
    socket.setTimeout(45000, () => socket.destroy(new Error('Control request timed out; delivery may be unknown.')));
    socket.on('connect', () => socket.write(payload));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 2_000_000) {
        socket.destroy(new Error('Control response exceeds limit.'));
        return;
      }
      if (!data.includes('\n')) return;
      socket.end();
      try {
        const result = JSON.parse(data.split('\n')[0]!);
        if (result.error) reject(new Error(result.error));
        else resolve(result.value);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('close', () => {
      if (!data.includes('\n')) reject(new Error('Session service disconnected; delivery may be unknown.'));
    });
  });
}

/** Start our local session host on demand. It is independent of archive import scheduling. */
export async function ensureControl(program: string[]): Promise<void> {
  try {
    await callControl({ method: 'list' });
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
  }
  const lock = socketPath() + '.starting';
  let owned = false;
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      owned = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await Bun.sleep(100);
    try {
      await callControl({ method: 'list' });
      return;
    } catch {}
  }
  if (!owned)
    throw new Error(`Another client is starting the session host. If it has exited, remove ${lock} and retry.`);
  try {
    try {
      await callControl({ method: 'list' });
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      try {
        unlinkSync(socketPath());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const child = spawn(program[0]!, [...program.slice(1), '--session-host'], { detached: true, stdio: 'ignore' });
    let launchError: Error | undefined;
    child.on('error', (error) => {
      launchError = error;
    });
    child.unref();
    for (let i = 0; i < 50; i++) {
      if (launchError) throw launchError;
      await Bun.sleep(100);
      try {
        await callControl({ method: 'list' });
        return;
      } catch {}
    }
    throw new Error('Session service did not start. Run pacifico --session-host to inspect the error.');
  } finally {
    rmdirSync(lock);
  }
}

export async function serveControl(): Promise<void> {
  const directory = join(getDataDir(), 'control');
  privateDirectory(directory);
  const databasePath = join(directory, 'requests.sqlite');
  let service: SessionService;
  const server = createServer((socket) => {
    let data = '';
    let handled = false;
    socket.setTimeout(60000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      data += chunk.toString();
      if (data.length > 100000) {
        handled = true;
        socket.destroy();
        return;
      }
      if (!data.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const req = Request.parse(JSON.parse(data.split('\n')[0]!));
          let value: unknown;
          switch (req.method) {
            case 'list':
              value = service.list();
              break;
            case 'stop':
              service.closeAll();
              value = { stopped: true };
              setTimeout(() => {
                server.close();
                setTimeout(() => process.exit(0), 100).unref();
              }, 50);
              break;
            case 'start':
              value = await service.start(req.harness, req.project, req.message, req.write);
              break;
            case 'send':
              value = await service.sendExisting(req.session, req.message, req.socket);
              break;
            case 'result':
              value = service.read(req.request);
              break;
            case 'close':
              service.close(req.session);
              value = { closed: true };
              break;
          }
          socket.end(JSON.stringify({ value }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath(), resolve);
  });
  chmodSync(socketPath(), 0o600);
  const db = new Database(databasePath, { create: true });
  chmodSync(databasePath, 0o600);
  service = new SessionService(db);
  const stop = () => {
    service.closeAll(true);
    server.close();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
