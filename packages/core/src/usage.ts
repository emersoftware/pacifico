import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { gatherEvents, type ReportRoots } from './report/extract';
import type { UsageEvent } from './report/parsers/types';
import { decisionProject } from './decisions';

const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const EventSchema = z.object({
  tool: z.enum(['claude-code', 'codex', 'opencode', 'cursor', 'antigravity']),
  model: z.string().min(1),
  sessionId: z.string().min(1),
  projectPath: z.string().optional(),
  timestamp: z.iso.datetime({ offset: true }),
  dedupKey: z.string().optional(),
  tokens: z.object({ input: Counter, output: Counter, cacheRead: Counter, cacheWrite: Counter }),
});
export type UsageRecord = z.infer<typeof EventSchema>;
export const PERIODS = ['today', '7d', '30d', '365d', 'all'] as const;
export type UsagePeriod = (typeof PERIODS)[number];
export type UsageGroup = 'day' | 'project' | 'harness' | 'model' | 'task';

function openUsage(): Database {
  mkdirSync(getDataDir(), { recursive: true });
  const db = new Database(join(getDataDir(), 'usage.sqlite'));
  chmodSync(join(getDataDir(), 'usage.sqlite'), 0o600);
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY, tool TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL,
    model TEXT NOT NULL, timestamp TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS usage_time ON usage_events(timestamp)');
  return db;
}

/** Stable native response identities prevent recounting copied transcripts and repeated imports. */
export function storeUsage(records: readonly (UsageRecord | UsageEvent)[]): number {
  const db = openUsage();
  try {
    return db.transaction(() => {
      const insert = db.prepare(`INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET input=excluded.input, output=excluded.output,
        cache_read=excluded.cache_read, cache_write=excluded.cache_write,
        project=CASE WHEN excluded.project <> '' THEN excluded.project ELSE usage_events.project END
        WHERE excluded.input <> usage_events.input OR excluded.output <> usage_events.output
          OR excluded.cache_read <> usage_events.cache_read OR excluded.cache_write <> usage_events.cache_write
          OR (excluded.project <> '' AND excluded.project <> usage_events.project)`);
      const occurrences = new Map<string, number>();
      let added = 0;
      for (const record of records) {
        const event = EventSchema.parse(record);
        const fingerprint = JSON.stringify([event.tool, event.sessionId, event.model, event.timestamp, event.tokens]);
        const count = occurrences.get(fingerprint) ?? 0;
        occurrences.set(fingerprint, count + 1);
        const identity = event.dedupKey ? `${event.tool}:${event.dedupKey}` : `${fingerprint}:${count}`;
        const id = createHash('sha256').update(identity).digest('hex');
        const t = event.tokens;
        added += insert.run(
          id,
          event.tool,
          event.sessionId,
          event.projectPath ?? '',
          event.model,
          new Date(event.timestamp).toISOString(),
          t.input,
          t.output,
          t.cacheRead,
          t.cacheWrite,
        ).changes;
      }
      return added;
    })();
  } finally {
    db.close();
  }
}

export async function refreshUsage(roots?: ReportRoots): Promise<number> {
  return storeUsage(await gatherEvents(roots));
}

/** These exports carry measured usage. Conversation text is never token-estimated. */
export function importUsageExport(harness: 'cursor' | 'antigravity', text: string, projectPath?: string): number {
  const rows: unknown[] =
    harness === 'cursor'
      ? z.object({ usageEventsDisplay: z.array(z.unknown()) }).parse(JSON.parse(text)).usageEventsDisplay
      : text
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
  const events: UsageRecord[] = [];
  let fallbackModel: string | undefined;
  for (const value of rows) {
    const row = z.record(z.string(), z.unknown()).parse(value);
    if (harness === 'antigravity' && row.type === 'session_meta') {
      fallbackModel = typeof row.modelId === 'string' ? row.modelId : undefined;
      continue;
    }
    if (harness === 'antigravity' && row.type !== 'usage') continue;
    const usage = harness === 'cursor' ? z.record(z.string(), z.unknown()).parse(row.tokenUsage) : row;
    const number = (field: string) => Counter.parse(Number(usage[field] ?? 0));
    const model = harness === 'cursor' ? row.model : (row.modelId ?? fallbackModel);
    const timestamp = new Date(Number(row.timestamp)).toISOString();
    const sessionId = harness === 'cursor' ? row.conversationId : row.sessionId;
    if (typeof model !== 'string' || typeof sessionId !== 'string' || !sessionId)
      throw new Error('Usage exports require a model and native session identifier.');
    events.push({
      tool: harness,
      model,
      sessionId,
      timestamp,
      projectPath,
      dedupKey: typeof row.responseId === 'string' ? row.responseId : undefined,
      tokens:
        harness === 'cursor'
          ? {
              input: number('inputTokens'),
              output: number('outputTokens'),
              cacheRead: number('cacheReadTokens'),
              cacheWrite: number('cacheWriteTokens'),
            }
          : {
              input: number('input'),
              output: number('output') + number('reasoning'),
              cacheRead: number('cacheRead'),
              cacheWrite: number('cacheWrite'),
            },
    });
  }
  return storeUsage(events);
}

function shiftDay(day: string, amount: number): string {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export interface UsageSummaryOptions {
  now?: Date;
  timezone?: string;
  project?: string;
  harness?: string;
  model?: string;
  task?: string;
  period?: UsagePeriod;
  group?: UsageGroup;
  limit?: number;
}
interface UsageRow {
  tool: string;
  session: string;
  project: string;
  model: string;
  timestamp: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}
export function queryUsage(options: UsageSummaryOptions = {}) {
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const now = options.now ?? new Date();
  const today = formatter.format(now);
  const starts = {
    today,
    '7d': shiftDay(today, -6),
    '30d': shiftDay(today, -29),
    '365d': shiftDay(today, -364),
    all: '',
  };
  const totals = { today: 0, '7d': 0, '30d': 0, '365d': 0, all: 0 };
  const days = new Set<string>();
  const groups = new Map<string, number>();
  const daily = new Map<string, number>();
  const models = new Map<string, number>();
  const sessions = new Set<string>();
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const harnesses = new Set<string>();
  const projects = new Map<string, string>();
  const project = options.project ? decisionProject(options.project) : undefined;
  const db = openUsage();
  try {
    for (const row of db.query<UsageRow, []>('SELECT * FROM usage_events').iterate()) {
      if (new Date(row.timestamp) > now) continue;
      if (options.harness && row.tool !== (options.harness === 'claude' ? 'claude-code' : options.harness)) continue;
      if (options.model && row.model !== options.model) continue;
      if (options.task && row.session !== options.task && `${row.tool}:${row.session}` !== options.task) continue;
      if (!projects.has(row.project)) projects.set(row.project, row.project ? decisionProject(row.project) : 'unknown');
      const normalizedProject = projects.get(row.project)!;
      if (project && project !== normalizedProject) continue;
      const tokens = row.input + row.output + row.cache_read + row.cache_write;
      if (!tokens) continue;
      const day = formatter.format(new Date(row.timestamp));
      days.add(day);
      harnesses.add(row.tool);
      for (const period of PERIODS) if (day >= starts[period]) totals[period] += tokens;
      if (day < starts[options.period ?? 'all']) continue;
      daily.set(day, (daily.get(day) ?? 0) + tokens);
      models.set(row.model, (models.get(row.model) ?? 0) + tokens);
      sessions.add(`${row.tool}:${row.session}`);
      breakdown.input += row.input;
      breakdown.output += row.output;
      breakdown.cacheRead += row.cache_read;
      breakdown.cacheWrite += row.cache_write;
      const key =
        options.group === 'day'
          ? day
          : options.group === 'project'
            ? normalizedProject
            : options.group === 'model'
              ? row.model
              : options.group === 'task'
                ? `${row.tool}:${row.session}`
                : row.tool;
      groups.set(key, (groups.get(key) ?? 0) + tokens);
    }
  } finally {
    db.close();
  }
  let current = 0,
    longest = 0,
    run = 0,
    previous = '';
  for (const day of [...days].sort()) {
    run = previous && day === shiftDay(previous, 1) ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  let cursor = days.has(today) ? today : shiftDay(today, -1);
  while (days.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }
  const limit = z
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(options.limit ?? 50);
  const rows = [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    generatedAt: now.toISOString(),
    timezone,
    unit: 'tokens',
    billion: 1_000_000_000,
    periods: Object.fromEntries(
      PERIODS.map((period) => [
        period,
        { from: starts[period] || null, to: today, tokens: totals[period], B: totals[period] / 1e9 },
      ]),
    ),
    streak: { currentDays: current, longestDays: longest, activeDays: days.size },
    activity: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens })),
    overview: {
      sessions: sessions.size,
      activeDays: daily.size,
      topModel: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      mostActiveDay: [...daily].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      breakdown,
    },
    group: options.group ?? 'harness',
    period: options.period ?? 'all',
    groups: rows.slice(0, limit).map(([key, tokens]) => ({ key, tokens, B: tokens / 1e9 })),
    truncated: rows.length > limit,
    coverage: {
      measuredHarnesses: [...harnesses].sort(),
      automatic: ['claude-code', 'codex', 'opencode'],
      exportOnly: ['cursor', 'antigravity'],
      taskMeaning: 'native session',
      note: 'Available recorded usage only. Missing usage is unknown, not zero. Totals include input, output, cache reads and cache writes once.',
    },
  };
}
