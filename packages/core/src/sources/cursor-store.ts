import { Database } from 'bun:sqlite';
import { cursorEvent } from './cursor-transcript';
import { type SourceEvent } from './records';
import { wireFields } from './protobuf';

export interface CursorStore {
  metadata: Record<string, unknown>;
  events: SourceEvent[];
  incomplete: boolean;
}

function object(bytes: Uint8Array | string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(
      typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Reads the current conversation graph in one SQLite snapshot, including committed WAL data. */
export function readCursorStore(path: string): CursorStore {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const metaRows = db.query('SELECT value FROM meta').all() as { value: string }[];
      const metadata = metaRows
        .map(({ value }) => object(value) ?? object(Buffer.from(value, 'hex')))
        .find((value) => typeof value?.latestRootBlobId === 'string');
      if (!metadata) throw new Error('Cursor store has no conversation root');
      const readBlob = db.query('SELECT data FROM blobs WHERE id = ?');
      const events: SourceEvent[] = [];
      const visited = new Set<string>();
      const pending = [metadata.latestRootBlobId as string];
      let incomplete = false;
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const row = readBlob.get(id) as { data: Uint8Array } | null;
        if (!row) {
          incomplete = true;
          continue;
        }
        const record = object(row.data);
        if (record) {
          if (typeof record.role === 'string') events.push(cursorEvent(record, id));
          continue;
        }
        const fields = wireFields(row.data);
        if (!fields) {
          incomplete = true;
          continue;
        }
        const children: string[] = [];
        for (const field of fields) {
          if (!(field.value instanceof Uint8Array)) continue;
          // Cursor graph references are 32-byte digests in fields 1 and 2.
          if ((field.number === 1 || field.number === 2) && field.value.length === 32) {
            children.push(Buffer.from(field.value).toString('hex'));
          } else {
            const embedded = object(field.value);
            if (embedded && typeof embedded.role === 'string') events.push(cursorEvent(embedded, id));
          }
        }
        pending.push(...children.reverse());
      }
      return { metadata, events, incomplete };
    })();
  } finally {
    db.close();
  }
}
