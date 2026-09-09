import { test, expect } from 'bun:test';
import { parseAntigravityTranscript, mergeAntigravityTranscripts } from './antigravity-transcript';

test('Antigravity preserves tool-only responses, compaction, unknown steps, and raw content', () => {
  const records = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      content: '<USER_REQUEST>Fix this</USER_REQUEST><ADDITIONAL_METADATA>context</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }],
    },
    { step_index: 2, type: 'RUN_COMMAND', source: 'MODEL', content: '/project', truncated_fields: ['content'] },
    { step_index: 3, type: 'CHECKPOINT', source: 'MODEL', content: 'Earlier context' },
    { step_index: 4, type: 'FUTURE_STEP', source: 'UNKNOWN', content: 'Retain me' },
  ];
  const result = parseAntigravityTranscript(records.map((r) => JSON.stringify(r)).join('\n') + '\n{"step_index":');
  expect(result.events.map((e) => e.role)).toEqual(['user', 'assistant', 'tool', 'system', 'unknown']);
  expect(result.events[0]?.text).toBe('Fix this');
  expect(result.events[0]?.raw).toEqual(records[0]);
  expect(result.events[1]?.toolCalls).toHaveLength(1);
  expect(result.events[2]?.truncated).toBe(true);
  expect(result.malformedLines).toBe(1);
});

test('full Antigravity records replace clipped steps without duplicating or losing clean-only steps', () => {
  const clean = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'question' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'clipped', truncated_fields: ['content'] },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'latest' },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
  const full =
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'complete answer' }) +
    '\n{partial';
  const result = mergeAntigravityTranscripts(clean, full);
  expect(result.events.map((event) => event.text)).toEqual(['question', 'complete answer', 'latest']);
  expect(result.events[1]?.truncated).toBe(false);
  expect(result.events[1]?.variants?.map((v) => [v.source, v.record.content])).toEqual([
    ['transcript.jsonl', 'clipped'],
    ['transcript_full.jsonl', 'complete answer'],
  ]);
  expect(result.events[2]?.variants?.[0]?.record.content).toBe('latest');
  expect(result.malformedLines).toBe(1);
});
