import type { SourceEvent } from '../sources/records';

/** Serializes native events without discarding their original records. */
export function projectSession(
  id: string,
  cwd: string,
  metadata: Record<string, unknown>,
  events: SourceEvent[],
): string[] {
  const lines = [
    JSON.stringify({
      type: 'session',
      pacifico: 1,
      sessionId: id,
      cwd,
      metadata,
      timestamp: events.find((e) => e.timestamp)?.timestamp,
    }),
  ];
  if (typeof metadata.name === 'string')
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: metadata.name }));
  for (const event of events) {
    const content: Record<string, unknown>[] = [];
    if (event.text) content.push({ type: 'text', text: event.text });
    if (event.thinking) content.push({ type: 'thinking', thinking: event.thinking });
    for (const call of event.toolCalls)
      content.push({ type: 'tool_use', name: call.name, input: call.input, id: call.id });
    lines.push(
      JSON.stringify({
        type: 'message',
        pacifico: 1,
        timestamp: event.timestamp,
        message: { role: event.role, content },
        source: event,
      }),
    );
  }
  return lines;
}
