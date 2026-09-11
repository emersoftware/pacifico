import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeUsage, queryUsage, importUsageExport, type UsageRecord } from './usage';
import { parseCodexFile } from './report/parsers/codex';
import { parseCodex } from './report/parsers/codex';
import { zstdCompressSync } from 'node:zlib';
let root: string, original: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pacifico-usage-'));
  original = process.env.SESSIONS_DATA_DIR;
  process.env.SESSIONS_DATA_DIR = root;
});
afterEach(() => {
  if (original === undefined) delete process.env.SESSIONS_DATA_DIR;
  else process.env.SESSIONS_DATA_DIR = original;
  rmSync(root, { recursive: true, force: true });
});
function event(date: string, id: string): UsageRecord {
  return {
    tool: 'codex',
    model: 'test-model',
    sessionId: 'session',
    timestamp: date,
    dedupKey: id,
    tokens: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 },
  };
}
test('deduplicates responses, updates streaming usage, and survives repeated refresh', () => {
  const a = event('2026-09-09T12:00:00Z', '1');
  expect(storeUsage([a, a])).toBe(1);
  expect(storeUsage([a])).toBe(0);
  storeUsage([{ ...a, tokens: { ...a.tokens, output: 40 } }]);
  expect(queryUsage({ now: new Date('2026-09-10T12:00:00Z'), timezone: 'UTC' }).periods.all!.tokens).toBe(220);
});
test('calendar windows, timezone, streaks, model filters, and session grouping', () => {
  storeUsage([
    event('2026-09-08T12:00:00Z', '1'),
    event('2026-09-09T12:00:00Z', '2'),
    event('2026-09-10T01:00:00Z', '3'),
  ]);
  const result = queryUsage({ now: new Date('2026-09-10T12:00:00Z'), timezone: 'America/Santiago', group: 'task' });
  expect(result.periods.today!.tokens).toBe(0);
  expect(result.periods['7d']!.tokens).toBe(600);
  expect(result.streak.currentDays).toBe(2);
  expect(result.groups[0]!.key).toBe('codex:session');
  expect(queryUsage({ model: 'missing' }).periods.all!.tokens).toBe(0);
});
test('imports measured Cursor and Antigravity exports idempotently', () => {
  const cursor = JSON.stringify({
    usageEventsDisplay: [
      {
        conversationId: 'cursor-session',
        model: 'auto',
        timestamp: 1789034400000,
        tokenUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 },
      },
    ],
  });
  expect(importUsageExport('cursor', cursor)).toBe(1);
  expect(importUsageExport('cursor', cursor)).toBe(0);
  expect(
    importUsageExport(
      'antigravity',
      JSON.stringify({
        type: 'usage',
        sessionId: 'agy',
        timestamp: 1789034400000,
        modelId: 'gemini',
        input: 10,
        output: 5,
        reasoning: 2,
      }),
    ),
  ).toBe(1);
  expect(queryUsage({ now: new Date('2026-09-11T00:00:00Z'), timezone: 'UTC' }).periods.all!.tokens).toBe(52);
});
test('Codex counters skip repeated totals and retain delta-only records without adding reasoning twice', async () => {
  const path = join(root, 'codex.jsonl');
  const count = (input: number, output: number, last = true) => ({
    timestamp: '2026-09-10T10:00:00Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output },
        ...(last
          ? {
              last_token_usage: {
                input_tokens: input,
                cached_input_tokens: 20,
                output_tokens: output,
                reasoning_output_tokens: 5,
              },
            }
          : {}),
      },
    },
  });
  writeFileSync(
    path,
    [
      { type: 'session_meta', timestamp: '2026-09-10T10:00:00Z', payload: { id: 's' } },
      { type: 'turn_context', timestamp: '2026-09-10T10:00:00Z', payload: { model: 'gpt-test' } },
      count(100, 10),
      count(100, 10),
      count(130, 15, false),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const events = await parseCodexFile(path);
  expect(events).toHaveLength(2);
  expect(events[0]!.tokens).toEqual({ input: 80, output: 10, cacheRead: 20, cacheWrite: 0 });
  expect(events[1]!.tokens.input).toBe(30);
  expect(events[1]!.tokens.output).toBe(5);
  writeFileSync(path + '.zst', zstdCompressSync(Buffer.from(await Bun.file(path).text())));
  expect(await parseCodex(root)).toHaveLength(2);
  rmSync(path);
  expect(await parseCodex(root)).toHaveLength(2);
});

test('overview and calendar follow the selected period without changing all-time totals', () => {
  storeUsage([event('2026-08-01T12:00:00Z', 'old'), event('2026-09-10T12:00:00Z', 'new')]);
  const result = queryUsage({ now: new Date('2026-09-10T13:00:00Z'), timezone: 'UTC', period: 'today' });
  expect(result.activity).toEqual([{ date: '2026-09-10', tokens: 200 }]);
  expect(result.overview).toEqual({
    sessions: 1,
    activeDays: 1,
    topModel: 'test-model',
    mostActiveDay: '2026-09-10',
    breakdown: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0 },
  });
  expect(result.periods.all!.tokens).toBe(400);
});
