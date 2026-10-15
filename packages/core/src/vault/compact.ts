import { createHash } from 'node:crypto';
import { extractMessages, extractSessionMetadata } from '../parser';
import { parseCodexLines } from '../report/parsers/codex';
import { parseClaudeCodeLines, dedupeEvents } from '../report/parsers/claude-code';
import { parseOpencodeRows } from '../report/parsers/opencode';
import { computeCost, find } from '../report/pricing';
import type { UsageEvent } from '../report/parsers/types';
import type { Tool } from '../types';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
function pick(value: RecordValue, keys: string[]): RecordValue {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
export const COMPACT_VERSION = 1;
export interface ArchiveSummary {
  type: 'pacifico_summary';
  version: 1;
  timestamp: string;
  startedAt: string;
  gitBranch?: string;
  elapsedMs: number | null;
  recordedExecutionMs: number | null;
  sourceRecords: number;
  removedRecords: number;
  unclassifiedRecords: number;
  sourceBytes: number;
  sourceHash: string;
  tokens: UsageEvent['tokens'];
  recordedCostUSD: number;
  estimatedCostUSD: number;
  unpricedModels: string[];
  usageKnown: boolean;
  /** Minimal accounting receipts preserve cross-session deduplication and daily reports. */
  usage: UsageEvent[];
}
export function archiveSummary(lines: string[]): ArchiveSummary | undefined {
  for (const line of lines.slice(-2)) {
    try {
      const record = JSON.parse(line);
      if (record.type === 'pacifico_summary' && record.version === COMPACT_VERSION) return record;
    } catch {}
  }
}

function usageEvents(records: RecordValue[], lines: string[], tool: Tool, sourcePath: string): UsageEvent[] {
  if (tool === 'codex') return dedupeEvents(parseCodexLines(lines));
  if (tool === 'claude') {
    const agentId = /\/subagents\/agent-([^/]+)\.jsonl$/.exec(sourcePath)?.[1];
    return dedupeEvents(parseClaudeCodeLines(records, agentId).events);
  }
  if (tool === 'opencode') {
    const rows = records.flatMap((record) => {
      if (record.type !== 'source_records') return [];
      if (record.format === 'json-storage' && Array.isArray(record.files)) {
        const header = records.find((row) => row.type === 'session') ?? {};
        return record.files.flatMap((value) => {
          const file = object(value);
          if (typeof file.path !== 'string' || !file.path.includes('/message/') || typeof file.content !== 'string')
            return [];
          return [
            { data: file.content, session_id: String(header.sessionId ?? ''), directory: String(header.cwd ?? '') },
          ];
        });
      }
      if (!Array.isArray(record.messages)) return [];
      const session = object(record.session);
      return record.messages.flatMap((value) => {
        const row = object(value);
        return typeof row.data === 'string' && typeof row.session_id === 'string'
          ? [{ data: row.data, session_id: row.session_id, directory: String(session.directory ?? '') }]
          : [];
      });
    });
    return parseOpencodeRows(rows);
  }
  return [];
}

const envelopeKeys = [
  'type',
  'timestamp',
  'sessionId',
  'cwd',
  'gitBranch',
  'isSidechain',
  'isCompactSummary',
  'promptSource',
  'isApiErrorMessage',
  'pacifico',
];
const metadataTypes = new Set([
  'turn_context',
  'file-history-snapshot',
  'queue-operation',
  'progress',
  'last-prompt',
  'summary',
  'token_usage_record',
  'system',
  'source_records',
]);
const codexMetadata = new Set([
  'token_count',
  'task_started',
  'task_complete',
  'thread_settings_applied',
  'turn_started',
  'turn_complete',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'context_compacted',
]);
function message(value: unknown): unknown {
  if (typeof value === 'string') return value;
  const original = object(value);
  const out = pick(original, ['role', 'content', 'id']);
  if (Array.isArray(out.content)) {
    out.content = out.content.filter(
      (block) => !['thinking', 'redacted_thinking'].includes(String(object(block).type)),
    );
  }
  return out;
}

/** Unknown native parts can be attachments or future tools, not disposable bookkeeping. */
function unprojectedParts(record: RecordValue): unknown[] {
  const candidates: unknown[] = [];
  if (Array.isArray(record.parts)) {
    for (const part of record.parts) {
      const row = object(part);
      try {
        candidates.push(typeof row.data === 'string' ? JSON.parse(row.data) : part);
      } catch {
        candidates.push(part);
      }
    }
  }
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      const row = object(file);
      if (typeof row.path !== 'string' || !row.path.includes('/part/')) continue;
      try {
        candidates.push(JSON.parse(String(row.content)));
      } catch {
        candidates.push(file);
      }
    }
  }
  const covered = new Set([
    'text',
    'reasoning',
    'tool',
    'patch',
    'step-start',
    'step-finish',
    'snapshot',
    'compaction',
  ]);
  return candidates.filter((part) => !covered.has(String(object(part).type)));
}

/** Retain conversation and tool evidence; reduce known bookkeeping before storage. */
export function compactTranscript(text: string, tool: Tool, sourcePath = ''): string {
  const lines = text.trimEnd().split('\n');
  if (archiveSummary(lines)) return text;
  const records: RecordValue[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // A malformed snapshot is retained losslessly by the caller, never partially compacted.
    const value = JSON.parse(line);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid transcript record');
    records.push(value);
  }
  const metadata = extractSessionMetadata(lines, tool);
  const usage = usageEvents(records, lines, tool, sourcePath);
  const tokens: UsageEvent['tokens'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  let recordedCostUSD = 0,
    estimatedCostUSD = 0;
  const unpricedModels = new Set<string>();
  for (const event of usage) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'] as const)
      tokens[key] = (tokens[key] ?? 0) + (event.tokens[key] ?? 0);
    if (event.costUSD !== undefined) recordedCostUSD += event.costUSD;
    else if (find(event.model)) estimatedCostUSD += computeCost(event.model, event.tokens, event.speed);
    else unpricedModels.add(event.model);
  }
  let removed = 0,
    unknown = 0,
    execution: number | null = null;
  const output: string[] = [JSON.stringify({ type: 'pacifico_context', timestamp: metadata.startedAt })];
  const durations = new Set<string>();
  for (const record of records) {
    const type = String(record.type ?? '');
    const payload = object(record.payload);
    // Claude emits one measured turn duration; repeated records share a stable serialization.
    if (type === 'system' && record.subtype === 'turn_duration' && typeof record.durationMs === 'number') {
      const key = JSON.stringify(record);
      if (!durations.has(key)) execution = (execution ?? 0) + Math.max(0, record.durationMs);
      durations.add(key);
    }
    let retained: RecordValue | null;
    if (['user', 'assistant', 'message'].includes(type)) {
      retained = { ...pick(record, envelopeKeys), message: message(record.message) };
      // Stable step identities are needed to retain missing Antigravity companion steps.
      const source = object(record.source);
      if (source.id !== undefined) retained.source = { id: source.id };
      if (source.role === 'unknown' || (source.role === 'tool' && !source.text)) {
        retained.source = source;
        unknown++;
      }
    } else if (type === 'source_records') {
      const parts = unprojectedParts(record);
      retained = parts.length ? { type: 'unclassified_source_records', source: record.source, parts } : null;
      if (parts.length) unknown++;
    } else if (type === 'session_meta') {
      retained = { type, timestamp: record.timestamp, payload: pick(payload, ['id', 'cwd', 'git']) };
    } else if (type === 'session') {
      retained = pick(record, ['type', 'pacifico', 'sessionId', 'cwd', 'timestamp', 'subagentText']);
      const native = records.find((row) => row.type === 'source_records');
      const parent = object(native?.session).parent_id;
      if (typeof parent === 'string') retained.parentSessionId = parent;
    } else if (type === 'response_item') {
      retained = payload.type === 'reasoning' ? null : { type, timestamp: record.timestamp, payload };
    } else if (type === 'event_msg') {
      retained = codexMetadata.has(String(payload.type)) ? null : { type, timestamp: record.timestamp, payload };
      if (payload.type === 'item_completed') {
        const item = object(payload.item);
        if (item.type === 'Reasoning') retained = null;
        else if (retained) retained.payload = pick(payload, ['type', 'turn_id', 'item']);
      }
    } else if (type === 'custom-title') retained = pick(record, ['type', 'customTitle']);
    else if (type === 'compacted') retained = pick(record, ['type', 'timestamp', 'message']);
    else if (metadataTypes.has(type)) retained = null;
    else {
      // Unknown source extensions may contain unique messages. Preserve until classified.
      retained = record;
      unknown++;
    }
    if (retained) output.push(JSON.stringify(retained));
    else removed++;
  }
  const elapsed = Date.parse(metadata.endedAt) - Date.parse(metadata.startedAt);
  const summary: ArchiveSummary = {
    type: 'pacifico_summary',
    version: COMPACT_VERSION,
    timestamp: metadata.endedAt,
    startedAt: metadata.startedAt,
    ...(tool === 'claude' && metadata.branch ? { gitBranch: metadata.branch } : {}),
    elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
    recordedExecutionMs: execution,
    sourceRecords: records.length,
    removedRecords: removed,
    unclassifiedRecords: unknown,
    sourceBytes: Buffer.byteLength(text),
    sourceHash: createHash('sha256').update(text).digest('hex'),
    tokens,
    recordedCostUSD,
    estimatedCostUSD,
    unpricedModels: [...unpricedModels].sort(),
    usageKnown: usage.length > 0,
    usage,
  };
  output.push(JSON.stringify(summary));
  // Preserve search-hit numbering, text and tool summaries across migration.
  if (JSON.stringify(extractMessages(lines)) !== JSON.stringify(extractMessages(output)))
    throw new Error('Compaction changed searchable messages');
  return output.join('\n') + '\n';
}
