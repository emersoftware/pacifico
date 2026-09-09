import { test, expect } from 'bun:test';
import { cursorEvent, parseCursorTranscript } from './cursor-transcript';

test('Cursor keeps native redaction and unknown records visible', () => {
  const raw = {
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: '[REDACTED]' },
        { type: 'tool_use', id: 'call1', name: 'Read', input: { path: '/repo/file' } },
      ],
    },
  };
  const parsed = parseCursorTranscript(
    [JSON.stringify(raw), JSON.stringify({ role: 'future', content: 'unknown' }), '{partial'].join('\n'),
  );
  expect(parsed.malformedLines).toBe(1);
  expect(parsed.events[0]?.raw).toEqual(raw);
  expect(parsed.events[0]?.text).toBe('[REDACTED]');
  expect(parsed.events[0]?.truncated).toBe(true);
  expect(parsed.events[0]?.toolCalls[0]?.id).toBe('call1');
  expect(parsed.events[1]?.role).toBe('unknown');
});

test('Cursor projects CLI blob records and transcript envelopes consistently', () => {
  const message = {
    role: 'user',
    content: [{ type: 'text', text: '<timestamp>now</timestamp><user_query>Find the decision</user_query>' }],
  };
  const blob = cursorEvent(message, 'blob');
  const transcript = cursorEvent({ role: 'user', message }, 'line');
  expect(blob.text).toBe('Find the decision');
  expect(transcript.text).toBe(blob.text);
  expect(blob.raw).toEqual(message);
});
