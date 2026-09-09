import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { antigravityStoredStep, readAntigravityStore, mergeAntigravitySteps } from './antigravity-store';

test('Antigravity stored steps project verified text fields and retain unknown bytes', () => {
  const user = Uint8Array.from([8, 14, 32, 3, 154, 1, 4, 18, 2, 104, 105]);
  const event = antigravityStoredStep({ idx: 7, step_type: 14, status: 3, step_format: 0, step_payload: user });
  expect([event.id, event.role, event.text]).toEqual(['7', 'user', 'hi']);
  expect(event.raw.step_payload).toEqual({ encoding: 'base64', data: Buffer.from(user).toString('base64') });
  const unknown = antigravityStoredStep({ idx: 8, step_type: 999, status: 3, step_format: 0, step_payload: user });
  expect(unknown.role).toBe('unknown');
  expect(unknown.text).toBe('');
  expect(unknown.raw.step_payload).toEqual(event.raw.step_payload);
});

test('Antigravity SQLite reader sees committed WAL steps in native order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-ag-store-'));
  const path = join(dir, 'session.db');
  const db = new Database(path);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB); CREATE TABLE trajectory_meta (trajectory_id TEXT)',
    );
    db.run('CREATE TABLE executor_metadata (idx INTEGER, data BLOB)');
    db.run('INSERT INTO executor_metadata VALUES (1, ?)', [Uint8Array.from([1, 2, 3])]);
    db.run("INSERT INTO trajectory_meta VALUES ('trajectory')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = readFileSync(path);
    const user = Uint8Array.from([8, 14, 32, 3, 154, 1, 4, 18, 2, 104, 105]);
    const assistant = Uint8Array.from([8, 15, 32, 3, 162, 1, 4, 10, 2, 111, 107]);
    db.run('INSERT INTO steps VALUES (2, 15, 3, 0, ?)', [assistant]);
    db.run('INSERT INTO steps VALUES (1, 14, 3, 0, ?)', [user]);
    const result = readAntigravityStore(path);
    expect(result.events.map((e) => [e.id, e.role, e.text])).toEqual([
      ['1', 'user', 'hi'],
      ['2', 'assistant', 'ok'],
    ]);
    expect(result.metadata).toEqual([{ trajectory_id: 'trajectory' }]);
    expect(result.auxiliary.executor_metadata).toEqual([{ idx: 1, data: { encoding: 'base64', data: 'AQID' } }]);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity merge retains database-only steps and both native representations', () => {
  const base = { role: 'assistant' as const, toolCalls: [], truncated: false };
  const stored = [
    { ...base, id: '0', text: 'database only', raw: { idx: 0 } },
    { ...base, id: '1', text: 'stored text', raw: { idx: 1, payload: 'retained' } },
  ];
  const companion = [{ ...base, id: '1', text: 'companion text', raw: { step_index: 1 } }];
  const merged = mergeAntigravitySteps(stored, companion);
  expect(merged.map((e) => e.text)).toEqual(['database only', 'companion text']);
  expect(merged[1]?.variants).toEqual([
    { source: 'sqlite:steps', record: stored[1]!.raw },
    { source: 'transcript.jsonl', record: companion[0]!.raw },
  ]);
  expect(stored[1]?.text).toBe('stored text');
});

test('Antigravity planner preserves repeated tool calls including incomplete JSON', () => {
  const bytes = (tag: number[], content: number[]) => [...tag, content.length, ...content];
  const string = (tag: number, value: string) => bytes([tag], [...Buffer.from(value)]);
  const call = (id: string, args: string) =>
    bytes([58], [...string(10, id), ...string(18, 'read_file'), ...string(26, args)]);
  const payload = [...call('one', '{"path":"a.ts"}'), ...call('two', '{"path":')];
  const step = Uint8Array.from([8, 15, 32, 3, ...bytes([162, 1], payload)]);
  const event = antigravityStoredStep({ idx: 0, step_type: 15, status: 3, step_format: 0, step_payload: step });
  expect(event.role).toBe('assistant');
  expect(event.toolCalls).toEqual([
    { id: 'one', name: 'read_file', input: { path: 'a.ts' } },
    { id: 'two', name: 'read_file', input: '{"path":' },
  ]);
});

test('Antigravity companion calls supplement stored calls by native call id', () => {
  const base = { id: '1', role: 'assistant' as const, text: '', truncated: false, raw: {} };
  const first = { id: 'first', name: 'read', input: { path: 'a' } };
  const old = { id: 'second', name: 'write', input: '{' };
  const complete = { id: 'second', name: 'write', input: { path: 'b' } };
  const result = mergeAntigravitySteps([{ ...base, toolCalls: [first, old] }], [{ ...base, toolCalls: [complete] }]);
  expect(result[0]?.toolCalls).toEqual([first, complete]);
  expect(old.input).toBe('{');
});

test('Antigravity generic results expose text while preserving error status and binary payload', () => {
  const payload = Uint8Array.from([8, 132, 1, 32, 7, 226, 8, 6, 18, 4, 10, 2, 111, 107]);
  const result = antigravityStoredStep({ idx: 9, step_type: 132, status: 7, step_format: 0, step_payload: payload });
  expect(result.role).toBe('tool');
  expect(result.text).toBe('ok');
  expect(result.raw.status).toBe(7);
  expect(result.toolCalls).toEqual([]);
  expect(result.raw.step_payload).toEqual({ encoding: 'base64', data: Buffer.from(payload).toString('base64') });
});

test('Antigravity companion omissions preserve native timestamp and reasoning', () => {
  const stored = {
    id: '4',
    role: 'assistant' as const,
    text: 'answer',
    toolCalls: [],
    truncated: false,
    raw: {},
    timestamp: '2026-09-08T12:00:00Z',
    thinking: 'native reasoning',
  };
  const companion = {
    id: '4',
    role: 'assistant' as const,
    text: 'answer from log',
    toolCalls: [],
    truncated: false,
    raw: {},
  };
  const merged = mergeAntigravitySteps([stored], [companion])[0]!;
  expect(merged.timestamp).toBe(stored.timestamp);
  expect(merged.thinking).toBe(stored.thinking);
  const explicit = mergeAntigravitySteps(
    [stored],
    [{ ...companion, timestamp: '2026-09-08T12:00:01Z', thinking: '' }],
  )[0]!;
  expect(explicit.timestamp).toBe('2026-09-08T12:00:01Z');
  expect(explicit.thinking).toBe('');
});
