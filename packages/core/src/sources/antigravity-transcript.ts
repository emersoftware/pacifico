import { type SourceTranscript, type SourceEvent } from './records';

/** Preserves every valid native step, including system records and tool-only model responses. */
export function parseAntigravityTranscript(text: string): SourceTranscript {
  const events: SourceEvent[] = [];
  let malformedLines = 0;
  for (const [lineIndex, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid step');
      raw = value as Record<string, unknown>;
      if (!Number.isInteger(raw.step_index) || typeof raw.type !== 'string') throw new Error('Invalid step');
    } catch {
      malformedLines++;
      continue;
    }
    const type = raw.type;
    let role: SourceEvent['role'] = 'unknown';
    if (type === 'USER_INPUT' && raw.source === 'USER_EXPLICIT') role = 'user';
    else if (type === 'PLANNER_RESPONSE') role = 'assistant';
    else if (['SYSTEM_MESSAGE', 'EPHEMERAL_MESSAGE', 'CHECKPOINT', 'CONVERSATION_HISTORY'].includes(String(type)))
      role = 'system';
    else if (raw.source === 'MODEL') role = 'tool';
    else if (raw.source === 'SYSTEM') role = 'system';
    let content = typeof raw.content === 'string' ? raw.content : '';
    if (role === 'user') {
      const request = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (request) content = request[1]!;
    }
    const toolCalls: SourceEvent['toolCalls'] = [];
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) {
        if (!call || typeof call !== 'object' || typeof call.name !== 'string') continue;
        toolCalls.push({ name: call.name, input: call.args, ...(typeof call.id === 'string' ? { id: call.id } : {}) });
      }
    }
    events.push({
      id: `${raw.step_index}:${lineIndex}`,
      role,
      ...(typeof raw.created_at === 'string' ? { timestamp: raw.created_at } : {}),
      text: content,
      ...(typeof raw.thinking === 'string' ? { thinking: raw.thinking } : {}),
      toolCalls,
      truncated: Array.isArray(raw.truncated_fields) && raw.truncated_fields.length > 0,
      raw,
    });
  }
  return { events, malformedLines };
}

/** Merges companion logs by native step identity; full records replace clipped records. */
export function mergeAntigravityTranscripts(
  clean: string,
  full: string,
  history: { source: string; text: string }[] = [],
): SourceTranscript {
  const first = parseAntigravityTranscript(clean);
  const second = parseAntigravityTranscript(full);
  const steps = new Map<number, SourceEvent>();
  const historical = history.map(({ source, text }) => [source, parseAntigravityTranscript(text)] as const);
  for (const [source, transcript] of [
    ...historical,
    ['transcript.jsonl', first],
    ['transcript_full.jsonl', second],
  ] as const) {
    for (const event of transcript.events) {
      const step = Number(event.raw.step_index);
      const variants = [...(steps.get(step)?.variants ?? []), { source, record: event.raw }];
      steps.set(step, { ...event, variants });
    }
  }
  return {
    events: [...steps.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, event]) => ({ ...event, id: String(event.raw.step_index) })),
    malformedLines:
      first.malformedLines +
      second.malformedLines +
      historical.reduce((sum, [, snapshot]) => sum + snapshot.malformedLines, 0),
  };
}
