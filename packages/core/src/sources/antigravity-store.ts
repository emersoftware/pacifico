import { Database } from 'bun:sqlite';
import { wireFields, type WireField } from './protobuf';
import type { SourceEvent } from './records';

function nested(fields: WireField[], number: number): WireField[] | null {
  const value = fields.find((f) => f.number === number)?.value;
  return value instanceof Uint8Array ? wireFields(value) : null;
}

function text(fields: WireField[], number: number): string {
  const value = fields.find((f) => f.number === number)?.value;
  if (!(value instanceof Uint8Array)) return '';
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function nativeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? { encoding: 'base64', data: Buffer.from(value).toString('base64') } : value,
    ]),
  );
}

/** Unknown payloads retain their binary source instead of guessing text from arbitrary fields. */
export function antigravityStoredStep(row: Record<string, unknown>): SourceEvent {
  const raw = nativeRow(row);
  const event: SourceEvent = {
    id: String(row.idx),
    role: 'unknown',
    text: '',
    toolCalls: [],
    truncated: false,
    raw,
  };
  if (!(row.step_payload instanceof Uint8Array) || row.step_format !== 0) return event;
  const fields = wireFields(row.step_payload);
  if (
    !fields ||
    fields.find((f) => f.number === 1)?.value !== BigInt(Number(row.step_type)) ||
    fields.find((f) => f.number === 4)?.value !== BigInt(Number(row.status))
  )
    return event;
  try {
    if (row.step_type === 14) {
      const payload = nested(fields, 19);
      if (payload) {
        event.text = text(payload, 2);
        event.role = 'user';
      }
    } else if (row.step_type === 132) {
      const payload = nested(fields, 140);
      const result = payload && nested(payload, 2);
      if (result) {
        event.text = text(result, 1);
        event.role = 'tool';
      }
    } else if (row.step_type === 15) {
      const payload = nested(fields, 20);
      if (payload) {
        event.text = text(payload, 1);
        event.role = 'assistant';
        for (const field of payload) {
          if (field.number !== 7 || !(field.value instanceof Uint8Array)) continue;
          const call = wireFields(field.value);
          if (!call) continue;
          const name = text(call, 2);
          if (!name) continue;
          const id = text(call, 1);
          let input: unknown = text(call, 3);
          if (typeof input === 'string' && input) {
            try {
              input = JSON.parse(input);
            } catch {
              /* Retain partial JSON as recorded. */
            }
          }
          event.toolCalls.push({ name, input, ...(id ? { id } : {}) });
        }
      }
    }
  } catch {
    event.text = '';
    event.role = 'unknown';
  }
  return event;
}

/** Reads a consistent native snapshot, retaining every step and conversation metadata row. */
export function readAntigravityStore(path: string): {
  events: SourceEvent[];
  metadata: Record<string, unknown>[];
  auxiliary: Record<string, Record<string, unknown>[]>;
} {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const auxiliary: Record<string, Record<string, unknown>[]> = {};
      for (const table of [
        'gen_metadata',
        'executor_metadata',
        'parent_references',
        'trajectory_metadata_blob',
        'battle_mode_infos',
      ]) {
        if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
          auxiliary[table] = db.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all().map(nativeRow);
        }
      }
      return {
        events: db
          .query<Record<string, unknown>, []>('SELECT * FROM steps ORDER BY idx')
          .all()
          .map(antigravityStoredStep),
        metadata: db.query<Record<string, unknown>, []>('SELECT * FROM trajectory_meta').all().map(nativeRow),
        auxiliary,
      };
    })();
  } finally {
    db.close();
  }
}

function mergeToolCalls(
  stored: SourceEvent['toolCalls'],
  companion: SourceEvent['toolCalls'],
): SourceEvent['toolCalls'] {
  const calls = [...stored];
  for (const call of companion) {
    const index = call.id ? calls.findIndex((existing) => existing.id === call.id) : -1;
    if (index === -1) calls.push(call);
    else calls[index] = call;
  }
  return calls;
}

/** Companion text enriches matching database steps; neither original record is discarded. */
export function mergeAntigravitySteps(stored: SourceEvent[], companion: SourceEvent[]): SourceEvent[] {
  const steps = new Map<string, SourceEvent>();
  for (const event of stored) {
    steps.set(event.id, {
      ...event,
      variants: [{ source: 'sqlite:steps', record: event.raw }, ...(event.variants ?? [])],
    });
  }
  for (const event of companion) {
    const previous = steps.get(event.id);
    steps.set(event.id, {
      ...event,
      text: event.text || previous?.text || '',
      ...((event.timestamp ?? previous?.timestamp) !== undefined
        ? { timestamp: event.timestamp ?? previous?.timestamp }
        : {}),
      ...((event.thinking ?? previous?.thinking) !== undefined
        ? { thinking: event.thinking ?? previous?.thinking }
        : {}),
      role: event.role === 'unknown' ? (previous?.role ?? 'unknown') : event.role,
      toolCalls: mergeToolCalls(previous?.toolCalls ?? [], event.toolCalls),
      variants: [
        ...(previous?.variants ?? []),
        ...(event.variants ?? [{ source: 'transcript.jsonl', record: event.raw }]),
      ],
    });
  }
  return [...steps.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
