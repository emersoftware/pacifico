import { type SourceEvent, type SourceTranscript } from './records';

/** Projects known Cursor fields while retaining the complete record for archival. */
export function cursorEvent(raw: Record<string, unknown>, id: string): SourceEvent {
  const message =
    raw.message && typeof raw.message === 'object' && !Array.isArray(raw.message)
      ? (raw.message as Record<string, unknown>)
      : raw;
  const role = raw.role ?? message.role;
  const content = message.content;
  const texts: string[] = [];
  const thoughts: string[] = [];
  const toolCalls: SourceEvent['toolCalls'] = [];
  if (typeof content === 'string') texts.push(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') texts.push(block.text);
      if (typeof block.thinking === 'string') thoughts.push(block.thinking);
      if ((block.type === 'tool_use' || block.type === 'tool-call') && typeof block.name === 'string') {
        toolCalls.push({
          name: block.name,
          input: block.input ?? block.args,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        });
      }
    }
  }
  let text = texts.join('\n');
  if (role === 'user') {
    const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    if (query) text = query[1]!;
  }
  return {
    id,
    role: role === 'user' || role === 'assistant' || role === 'tool' || role === 'system' ? role : 'unknown',
    ...(typeof raw.timestamp === 'string' ? { timestamp: raw.timestamp } : {}),
    text,
    ...(thoughts.length ? { thinking: thoughts.join('\n') } : {}),
    toolCalls,
    truncated: texts.some((text) => text.includes('[REDACTED]')),
    raw,
  };
}

export function parseCursorTranscript(text: string): SourceTranscript {
  const events: SourceEvent[] = [];
  let malformedLines = 0;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid record');
      events.push(cursorEvent(raw as Record<string, unknown>, String(index)));
    } catch {
      malformedLines++;
    }
  }
  return { events, malformedLines };
}
