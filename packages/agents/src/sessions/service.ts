import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { connectClaude } from './channel';
import { connectCodex, openSession, DeliveryUnknownError, type Harness, type SessionAdapter } from './adapters';

export interface ActiveSession {
  session: string;
  harness: Harness;
  project: string;
  status: 'ready' | 'busy' | 'disconnected';
  write: boolean | null;
}
export interface RequestResult {
  request: string;
  session: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  text: string;
  error?: string;
  truncated?: boolean;
}
export type SessionFactory = typeof openSession;

/** Owns live sessions and correlates each response with exactly one submitted request. */
export class SessionService {
  private live = new Map<string, { info: ActiveSession; adapter: SessionAdapter }>();
  constructor(
    private db: Database,
    private factory: SessionFactory = openSession,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    for (const row of db.query<{ id: string; data: string }, []>('SELECT id, data FROM requests').all()) {
      const request: RequestResult = JSON.parse(row.data);
      if (request.status === 'running')
        this.save({ ...request, status: 'unknown', error: 'Connection was lost. This request was not retried.' });
    }
  }
  list(): ActiveSession[] {
    return [...this.live.values()].map(({ info }) => ({ ...info }));
  }
  async start(harness: Harness, project: string, message: string, write = false): Promise<RequestResult> {
    this.validateMessage(message);
    if (!isAbsolute(project)) throw new Error('Project must be an absolute directory path.');
    project = realpathSync(project);
    if (!statSync(project).isDirectory()) throw new Error('Project must be a directory.');
    let ended = false;
    let session = '';
    const adapter = await this.factory(
      harness,
      project,
      () => {
        ended = true;
        const live = this.live.get(session);
        if (live) live.info.status = 'disconnected';
      },
      {},
      write,
    );
    session = `${harness}:${adapter.id}`;
    if (ended) {
      adapter.close();
      throw new Error('Harness exited before the session was ready.');
    }
    this.live.set(session, { adapter, info: { session, harness, project, status: 'ready', write } });
    return this.send(session, message);
  }
  private connecting = new Map<string, Promise<void>>();
  async sendExisting(session: string, message: string, socket?: string): Promise<RequestResult> {
    this.validateMessage(message);
    if (!this.live.has(session) || this.live.get(session)?.info.status === 'disconnected') {
      let pending = this.connecting.get(session);
      if (!pending) {
        pending = this.attach(session, socket);
        this.connecting.set(session, pending);
      }
      try {
        await pending;
      } finally {
        this.connecting.delete(session);
      }
    }
    return this.send(session, message);
  }
  private async attach(session: string, socket?: string) {
    const match = /^(claude|codex):([a-zA-Z0-9_-]{1,100})$/.exec(session);
    if (!match) throw new Error('Use claude:<native-id> or codex:<native-id>.');
    const harness = match[1] as Harness,
      id = match[2]!;
    if (socket && harness !== 'codex') throw new Error('A socket option is only supported for Codex.');
    let ended = false;
    const onExit = () => {
      ended = true;
      const target = this.live.get(session);
      if (target) target.info.status = 'disconnected';
    };
    const adapter = harness === 'codex' ? await connectCodex(id, onExit, socket) : connectClaude(id, onExit);
    if (ended) {
      adapter.close();
      throw new Error('Session disconnected while attaching.');
    }
    this.live.set(session, { adapter, info: { session, harness, project: '', status: 'ready', write: null } });
  }
  send(session: string, message: string): RequestResult {
    this.validateMessage(message);
    const target = this.live.get(session);
    if (!target || target.info.status === 'disconnected')
      throw new Error('Session is not connected. No new session was created.');
    if (target.info.status === 'busy') throw new Error('Session is busy. No message was sent.');
    const result: RequestResult = { request: randomUUID(), session, status: 'running', text: '' };
    this.save(result);
    target.info.status = 'busy';
    void target.adapter
      .send(message)
      .then(
        (text) => {
          this.save({ ...result, status: 'completed', text });
        },
        (error) => {
          if (error instanceof DeliveryUnknownError) {
            target.info.status = 'disconnected';
            target.adapter.close();
          }
          this.save({
            ...result,
            status: error instanceof DeliveryUnknownError ? 'unknown' : 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        if (target.info.status === 'busy') target.info.status = 'ready';
      });
    return result;
  }
  read(id: string): RequestResult {
    const row = this.db.query<{ data: string }, [string]>('SELECT data FROM requests WHERE id = ?').get(id);
    if (!row) throw new Error('Request not found.');
    const result: RequestResult = JSON.parse(row.data);
    if (result.text.length > 20000) return { ...result, text: result.text.slice(0, 20000), truncated: true };
    return result;
  }
  close(session: string): void {
    const target = this.live.get(session);
    if (!target) throw new Error('Session is not connected.');
    if (target.info.status === 'busy') throw new Error('Session is busy. Wait for its request before closing.');
    target.info.status = 'disconnected';
    target.adapter.close();
  }
  closeAll(force = false): void {
    if (!force && this.list().some((session) => session.status === 'busy'))
      throw new Error('Sessions are busy. Wait for their requests before stopping the host.');
    for (const { info, adapter } of this.live.values()) {
      info.status = 'disconnected';
      adapter.close();
    }
  }
  private save(result: RequestResult) {
    this.db
      .query('INSERT OR REPLACE INTO requests (id, data) VALUES (?, ?)')
      .run(result.request, JSON.stringify(result));
  }
  private validateMessage(message: string) {
    if (!message.trim() || Buffer.byteLength(message) > 64000)
      throw new Error('Message must contain 1 to 64000 UTF-8 bytes.');
  }
}
