export type Harness = 'claude' | 'codex' | 'cursor' | 'antigravity' | 'opencode';

/** Native records remain attached so a projection never becomes the only surviving evidence. */
export interface SourceEvent {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'unknown';
  timestamp?: string;
  text: string;
  thinking?: string;
  toolCalls: { name: string; input: unknown; id?: string }[];
  truncated: boolean;
  raw: Record<string, unknown>;
  variants?: { source: string; record: Record<string, unknown> }[];
}

export interface SourceTranscript {
  events: SourceEvent[];
  malformedLines: number;
}
