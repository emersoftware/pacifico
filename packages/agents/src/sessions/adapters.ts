import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import websocket from 'websocket-driver';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { version } from '../../../../package.json';

export type Harness = 'claude' | 'codex';
export class DeliveryUnknownError extends Error {}
export interface SessionAdapter {
  id: string;
  send(message: string): Promise<string>;
  close(): void;
}

/** Official CLI transports only. Each adapter owns one live conversation. */
export async function openSession(
  harness: Harness,
  cwd: string,
  onExit: () => void,
  commands: Partial<Record<Harness, string[]>> = {},
  write = false,
): Promise<SessionAdapter> {
  const nativeId = randomUUID();
  const command =
    commands[harness] ??
    (harness === 'codex'
      ? ['codex', 'app-server']
      : [
          'claude',
          '-p',
          '--session-id',
          nativeId,
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          write ? 'acceptEdits' : 'dontAsk',
          ...(write ? [] : ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']),
        ]);
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: 'pipe' });
  return harness === 'codex'
    ? openCodex(
        {
          send: (value) => child.stdin.write(JSON.stringify(value) + '\n'),
          close: () => {
            child.kill();
          },
          listen: (receive, fail) => lines(child, receive, fail),
        },
        cwd,
        onExit,
        write,
      )
    : openClaude(child, onExit, nativeId);
}

function lines(child: ChildProcessWithoutNullStreams, receive: (value: any) => void, fail: (error: Error) => void) {
  const reader = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  reader.on('line', (line) => {
    try {
      receive(JSON.parse(line));
    } catch (error) {
      fail(new Error(`Invalid harness response: ${String(error)}`));
    }
  });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code) => fail(new DeliveryUnknownError(`Harness exited (${code ?? 'signal'}). ${stderr}`.trim())));
}

interface CodexTransport {
  send(value: unknown): void;
  close(): void;
  listen(receive: (value: any) => void, fail: (error: Error) => void): void;
}

async function openCodex(
  transport: CodexTransport,
  cwd: string,
  onExit: () => void,
  allowWrite: boolean,
  existingId?: string,
): Promise<SessionAdapter> {
  let nextId = 0;
  let sessionId = '';
  let closed: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let turnId: string | undefined;
  let buffered: any[] = [];
  let receiveEvent: (event: any) => void;
  let turn: { resolve: (text: string) => void; reject: (error: Error) => void; text: string } | undefined;
  function fail(error: Error) {
    if (closed) return;
    closed = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    turn?.reject(error);
    turn = undefined;
    transport.close();
    onExit();
  }
  function write(value: unknown) {
    transport.send(value);
  }
  function rpc(method: string, params: unknown): Promise<any> {
    if (closed) return Promise.reject(closed);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DeliveryUnknownError(`Codex ${method} acknowledgement timed out; delivery may be unknown.`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  }
  transport.listen(
    (receiveEvent = (event) => {
      if (event.id != null && event.method) {
        // Preserve denial semantics when no interactive approval host is attached.
        const decision =
          event.method === 'item/commandExecution/requestApproval' ||
          event.method === 'item/fileChange/requestApproval';
        write(
          decision
            ? { id: event.id, result: { decision: 'decline' } }
            : { id: event.id, error: { code: -32601, message: 'No interactive approval host is attached.' } },
        );
        return;
      }
      if (event.id != null) {
        const request = pending.get(event.id);
        if (!request) return;
        pending.delete(event.id);
        clearTimeout(request.timer);
        if (event.error) request.reject(new Error(event.error.message));
        else request.resolve(event.result);
        return;
      }
      if (event.params?.threadId !== sessionId || !turn) return;
      if (!turnId) {
        buffered.push(event);
        return;
      }
      if ((event.params.turnId ?? event.params.turn?.id) !== turnId) return;
      if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') {
        turn.text += (turn.text ? '\n\n' : '') + event.params.item.text;
      }
      if (event.method === 'turn/completed') {
        const current = turn;
        turn = undefined;
        if (event.params.turn.status === 'completed') current.resolve(current.text);
        else current.reject(new Error(event.params.turn.error?.message ?? `Turn ${event.params.turn.status}`));
      }
    }),
    fail,
  );
  try {
    await rpc('initialize', { clientInfo: { name: 'pacifico', version } });
    write({ method: 'initialized' });
    if (existingId) {
      let cursor: string | undefined;
      let found = false;
      do {
        const page = await rpc('thread/loaded/list', { cursor });
        found = page.data.includes(existingId);
        cursor = page.nextCursor;
      } while (!found && cursor);
      if (!found) throw new Error('Session is not loaded in this App Server. No session was created.');
      const current = await rpc('thread/read', { threadId: existingId });
      if (current.thread.status?.type !== 'idle') throw new Error('Session is not idle. No message was sent.');
    }
    const result = existingId
      ? await rpc('thread/resume', { threadId: existingId })
      : await rpc('thread/start', {
          cwd,
          approvalPolicy: 'never',
          sandbox: allowWrite ? 'workspace-write' : 'read-only',
        });
    sessionId = result.thread.id;
    return {
      id: sessionId,
      async send(message) {
        if (existingId) {
          const current = await rpc('thread/read', { threadId: sessionId });
          if (current.thread.status?.type !== 'idle') throw new Error('Session is not idle. No message was sent.');
        }
        if (closed) return Promise.reject(closed);
        if (turn) return Promise.reject(new Error('Session is busy.'));
        return new Promise((resolve, reject) => {
          const current = { resolve, reject, text: '' };
          turn = current;
          turnId = undefined;
          buffered = [];
          void rpc('turn/start', { threadId: sessionId, input: [{ type: 'text', text: message }] })
            .then((result) => {
              turnId = result.turn.id;
              const events = buffered;
              buffered = [];
              for (const event of events) receiveEvent(event);
            })
            .catch((error) => {
              current.reject(error);
              if (turn === current) turn = undefined;
            });
        });
      },
      close() {
        fail(new Error('Session disconnected.'));
      },
    };
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

function openClaude(child: ChildProcessWithoutNullStreams, onExit: () => void, nativeId: string): SessionAdapter {
  let closed: Error | undefined;
  let pending: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  const adapter: SessionAdapter = {
    id: nativeId,
    send(message) {
      if (closed) return Promise.reject(closed);
      if (pending) return Promise.reject(new Error('Session is busy.'));
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.stdin.write(
          JSON.stringify({
            type: 'user',
            uuid: randomUUID(),
            session_id: adapter.id,
            parent_tool_use_id: null,
            message: { role: 'user', content: message },
          }) + '\n',
        );
      });
    },
    close() {
      fail(new Error('Session disconnected.'));
    },
  };
  function fail(error: Error) {
    if (closed) return;
    closed = error;
    pending?.reject(error);
    pending = undefined;
    child.kill();
    onExit();
  }
  lines(
    child,
    (event) => {
      if (event.session_id) adapter.id = event.session_id;
      if (event.type !== 'result' || !pending) return;
      const current = pending;
      pending = undefined;
      if (event.is_error || event.subtype !== 'success')
        current.reject(new Error(event.result ?? event.errors?.join('\n') ?? 'Claude turn failed.'));
      else current.resolve(event.result ?? '');
    },
    fail,
  );
  return adapter;
}

/** Attach to the official local WebSocket transport without owning the receiving process. */
export async function connectCodex(id: string, onExit: () => void, socket?: string): Promise<SessionAdapter> {
  const path =
    socket ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control/app-server-control.sock');
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.())
    throw new Error('Expected a Codex socket owned by the current user.');
  const driver = websocket.client('ws://localhost/', { maxLength: 32 * 1024 * 1024 });
  const socketConnection = createConnection(path);
  socketConnection.pipe(driver.io).pipe(socketConnection);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socketConnection.destroy();
      reject(new Error('Codex WebSocket handshake timed out.'));
    }, 5000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socketConnection.destroy();
      reject(error);
    };
    driver.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    driver.on('error', fail);
    socketConnection.on('error', fail);
    socketConnection.on('connect', () => driver.start());
  });
  return openCodex(
    {
      send: (value) => {
        if (!driver.text(JSON.stringify(value))) throw new DeliveryUnknownError('Codex transport is closed.');
      },
      close: () => {
        driver.close();
        socketConnection.destroy();
      },
      listen(receive, fail) {
        driver.on('message', (event: { data: string }) => {
          try {
            receive(JSON.parse(event.data));
          } catch (error) {
            fail(new Error(`Invalid Codex response: ${String(error)}`));
          }
        });
        driver.on('error', fail);
        socketConnection.on('error', fail);
        socketConnection.on('close', () =>
          fail(new DeliveryUnknownError('Codex connection closed before the response.')),
        );
      },
    },
    process.cwd(),
    onExit,
    false,
    id,
  );
}
