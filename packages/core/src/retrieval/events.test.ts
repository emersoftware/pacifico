import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSessionEvents } from './events';

test('event pagination reconstructs large tool records without dropping subsequent events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-events-'));
  try {
    const path = join(dir, 'events.jsonl');
    const records = [
      JSON.stringify({ type: 'session', id: 'test' }),
      JSON.stringify({ role: 'tool', result: 'x'.repeat(45_000) }),
      JSON.stringify({ role: 'system', text: 'retained' }),
    ];
    writeFileSync(path, records.join('\n'));
    const rebuilt = ['', '', ''];
    let cursor: { offset: number; characterOffset: number; version?: string } | null = {
      offset: 0,
      characterOffset: 0,
    };
    let pages = 0;
    while (cursor) {
      const page = readSessionEvents(path, cursor.offset, 20, cursor.characterOffset, cursor.version);
      expect(page.events.reduce((sum, event) => sum + event.text.length, 0)).toBeLessThanOrEqual(20_000);
      for (const event of page.events) rebuilt[event.index] += event.text;
      cursor = page.next;
      expect(++pages).toBeLessThan(10);
    }
    expect(rebuilt).toEqual(records);
    expect(readSessionEvents(path, 2, 1).events[0]?.text).toBe(records[2]);
    expect(() => readSessionEvents(path, 0, 1, 1000)).toThrow('characterOffset');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing sessions fail while an empty readable file has no events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-events-missing-'));
  try {
    const path = join(dir, 'empty.jsonl');
    expect(() => readSessionEvents(path)).toThrow('missing or unreadable');
    writeFileSync(path, '');
    expect(readSessionEvents(path)).toMatchObject({ total: 0, events: [], next: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('event cursors reject same-length source rewrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-event-version-'));
  try {
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, '{"text":"first"}\n{"text":"later"}');
    const page = readSessionEvents(path, 0, 1);
    writeFileSync(path, '{"text":"other"}\n{"text":"later"}');
    expect(() => readSessionEvents(path, page.next!.offset, 1, 0, page.next!.version)).toThrow('changed between pages');
    expect(readSessionEvents(path).version).not.toBe(page.version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
