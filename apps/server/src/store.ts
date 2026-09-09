import { SQL } from 'bun';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash, snapshotHash, snapshotKey, type Identity, type Snapshot } from '@pacifico/core/sync/protocol';
import {
  extractSessionMetadata,
  extractMessages,
  customTitle,
  firstPrompt,
  sessionBranch,
  summarizeMessages,
} from '@pacifico/core/parser';
import { extractFiles } from '@pacifico/core/extract-files';
import { extractCommands } from '@pacifico/core/extract-commands';
import { extractErrors } from '@pacifico/core/extract-errors';

export class Conflict extends Error {}
export class Store {
  readonly sql: SQL;
  constructor(url: string) {
    this.sql = new SQL(url, { max: 10 });
  }
  async migrate() {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(782361)`;
      await tx.unsafe(`
        CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, name text UNIQUE NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL);
        CREATE TABLE IF NOT EXISTS credentials (hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), device_id uuid REFERENCES devices(id), scope text NOT NULL CHECK(scope IN ('read','sync')));
        CREATE TABLE IF NOT EXISTS snapshots (
          user_id uuid NOT NULL REFERENCES users(id), device_id uuid NOT NULL REFERENCES devices(id), key text NOT NULL,
          hash text NOT NULL, item jsonb NOT NULL, projection jsonb NOT NULL,
          PRIMARY KEY(user_id, device_id, key));
        CREATE TABLE IF NOT EXISTS versions (
          user_id uuid NOT NULL, device_id uuid NOT NULL, key text NOT NULL, hash text NOT NULL, item jsonb NOT NULL,
          received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, device_id, key, hash));
        CREATE TABLE IF NOT EXISTS search_messages (
          user_id uuid NOT NULL, device_id uuid NOT NULL, key text NOT NULL, message_index integer NOT NULL,
          role text NOT NULL, text text NOT NULL, chunk integer NOT NULL DEFAULT 0,
          PRIMARY KEY(user_id,device_id,key,message_index),
          FOREIGN KEY(user_id,device_id,key) REFERENCES snapshots(user_id,device_id,key) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS search_chunks (
          user_id uuid NOT NULL, device_id uuid NOT NULL, key text NOT NULL, message_index integer NOT NULL,
          chunk integer NOT NULL, role text NOT NULL, text text NOT NULL,
          tokens tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
          PRIMARY KEY(user_id, device_id, key, message_index, chunk),
          FOREIGN KEY(user_id, device_id, key) REFERENCES snapshots(user_id, device_id, key) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS search_chunks_tokens ON search_chunks USING gin(tokens);
        CREATE INDEX IF NOT EXISTS snapshots_user ON snapshots(user_id);
      `);
    });
  }
  async credential(user: string, device?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.sql.begin(async (tx) => {
      const [account] =
        await tx`INSERT INTO users(id,name) VALUES (${randomUUID()},${user}) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id`;
      let deviceId: string | null = null;
      if (device) {
        deviceId = randomUUID();
        await tx`INSERT INTO devices(id,user_id,name) VALUES (${deviceId},${account.id},${device})`;
      }
      await tx`INSERT INTO credentials(hash,user_id,device_id,scope) VALUES (${hash(token)},${account.id},${deviceId},${device ? 'sync' : 'read'})`;
    });
    return token;
  }
  async authenticate(token: string): Promise<Identity | null> {
    const [row] = await this
      .sql`SELECT c.user_id AS "userId", u.name AS "user", c.device_id AS "deviceId", d.name AS device, c.scope
      FROM credentials c JOIN users u ON u.id=c.user_id LEFT JOIN devices d ON d.id=c.device_id WHERE c.hash=${hash(token)}`;
    return row ?? null;
  }
  async inventory(identity: Identity) {
    return this.sql`SELECT key,hash FROM snapshots WHERE user_id=${identity.userId} AND device_id=${identity.deviceId}`;
  }
  async save(identity: Identity, item: Snapshot, previousHash: string | null) {
    if (identity.scope !== 'sync' || !identity.deviceId) throw new Error('Read-only credential');
    const key = snapshotKey(item),
      digest = snapshotHash(item);
    const lines = item.content.split('\n');
    const messages = item.kind === 'session' ? extractMessages(lines) : [];
    const metadata = item.kind === 'session' ? extractSessionMetadata(lines, item.harness) : null;
    const summary = summarizeMessages(messages);
    const projection = {
      title: item.kind === 'session' ? customTitle(lines) : '',
      opening: item.kind === 'session' ? firstPrompt(lines, item.harness) : '',
      date: metadata?.date || item.modifiedAt.slice(0, 10),
      createdAt: metadata?.createdAt || item.modifiedAt.slice(0, 10),
      closing: { user: summary.closingUser, assistant: summary.closingAssistant },
      branch: item.kind === 'session' ? sessionBranch(lines, item.harness) : '',
      files: item.kind === 'session' ? extractFiles(lines, item.harness) : [],
      commands: item.kind === 'session' ? extractCommands(lines, item.harness) : [],
      errored: item.kind === 'session' ? extractErrors(lines, item.harness).errored : false,
      messageCount: messages.length,
    };
    await this.sql.begin(async (tx) => {
      // Serialize first insert as well as updates, so a delayed retry cannot replace a newer snapshot.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity.deviceId + key},0))`;
      const [current] =
        await tx`SELECT hash FROM snapshots WHERE user_id=${identity.userId} AND device_id=${identity.deviceId} AND key=${key}`;
      if (current?.hash === digest) return;
      if ((current?.hash ?? null) !== previousHash) throw new Conflict('Snapshot changed; retry synchronization');
      const encoded = item,
        projected = projection;
      await tx`INSERT INTO snapshots(user_id,device_id,key,hash,item,projection)
        VALUES (${identity.userId},${identity.deviceId},${key},${digest},${encoded}::jsonb,${projected}::jsonb)
        ON CONFLICT(user_id,device_id,key) DO UPDATE SET hash=excluded.hash,item=excluded.item,projection=excluded.projection`;
      await tx`INSERT INTO versions(user_id,device_id,key,hash,item) VALUES (${identity.userId},${identity.deviceId},${key},${digest},${encoded}::jsonb) ON CONFLICT DO NOTHING`;
      await tx`DELETE FROM search_chunks WHERE user_id=${identity.userId} AND device_id=${identity.deviceId} AND key=${key}`;
      await tx`DELETE FROM search_messages WHERE user_id=${identity.userId} AND device_id=${identity.deviceId} AND key=${key}`;
      for (const message of messages) {
        await tx`INSERT INTO search_messages(user_id,device_id,key,message_index,role,text)
          VALUES (${identity.userId},${identity.deviceId},${key},${message.index},${message.role},${message.text})`;
      }
      const searchable = [
        {
          index: -1,
          role: 'metadata',
          text: item.kind === 'session' ? `${item.cwd}\n${projection.title}\n${projection.opening}` : item.content,
        },
        ...messages,
      ];
      for (const message of searchable) {
        if (message.role === 'user' && 'genuine' in message && !message.genuine) continue;
        for (let start = 0, chunk = 0; start < message.text.length; start += 15000, chunk++) {
          await tx`INSERT INTO search_chunks(user_id,device_id,key,message_index,chunk,role,text)
            VALUES (${identity.userId},${identity.deviceId},${key},${message.index},${chunk},${message.role},${message.text.slice(start, start + 16000)})`;
        }
      }
    });
    return { key, hash: digest };
  }
  async close() {
    await this.sql.close();
  }
}
