// Sessions-owned (forked from tokenmaxing's parser). Codex's input_tokens are cache-inclusive and
// output_tokens already include reasoning; correct both so totals reflect actual billing (and match ccusage).
import { z } from 'zod';

import type { UsageEvent } from './types.ts';
import { readCodexRollout } from '../../sources/codex-rollout';
import { walkJsonl, type WalkOptions } from './walk.ts';

const codexEnvelopeSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.unknown().optional(),
});

const sessionMetaPayloadSchema = z.object({
  id: z.string(),
  cwd: z.string().optional(),
});
const turnContextPayloadSchema = z.object({ model: z.string() });
const tokenCountPayloadSchema = z.object({
  type: z.literal('token_count'),
  info: z
    .object({
      total_token_usage: z.record(z.string(), z.number()).optional(),
      last_token_usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          reasoning_output_tokens: z.number().optional(),
          cached_input_tokens: z.number().optional(),
        })
        .optional(),
    })
    .nullable(),
});

export async function parseCodex(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const path of walkJsonl(root, { ...opts, compressed: true })) events.push(...(await parseCodexFile(path)));
  return events;
}

/** Parse one rollout file. Self-contained (session meta and model are declared
 *  inside it), so the result is cacheable against the file's mtime. */
export async function parseCodexFile(path: string): Promise<UsageEvent[]> {
  return parseCodexLines(readCodexRollout(path).toString('utf8').split('\n'));
}

export function parseCodexLines(lines: string[]): UsageEvent[] {
  const records: unknown[] = [];
  for (const raw of lines) {
    try {
      const record = JSON.parse(raw);
      if (
        ['session_meta', 'turn_context', 'token_usage_record'].includes(record.type) ||
        (record.type === 'event_msg' && record.payload?.type === 'token_count')
      )
        records.push(record);
    } catch {}
  }
  return parseCodexRecords(records);
}

export function parseCodexRecords(records: unknown[]): UsageEvent[] {
  const events: UsageEvent[] = [];
  {
    // Match per-response receipts to their cumulative UI twins without dropping
    // older usage in sessions that span a native format upgrade.
    const counterKey = (u: Record<string, number>) =>
      JSON.stringify([
        u.input_tokens ?? 0,
        u.output_tokens ?? 0,
        u.cached_input_tokens ?? 0,
        u.cache_write_input_tokens ?? 0,
      ]);
    const receiptTotals = new Set<string>();
    const receiptTimes = new Set<string>();
    for (const record of records) {
      try {
        const row = z
          .object({
            type: z.string(),
            timestamp: z.string(),
            payload: z.object({
              response_id: z.string().optional(),
              usage: z.record(z.string(), z.number()).optional(),
              thread_token_usage: z.record(z.string(), z.number()).optional(),
            }),
          })
          .parse(record);
        if (row.type !== 'token_usage_record' || !row.payload?.response_id || !row.payload?.usage) continue;
        if (row.payload.thread_token_usage) receiptTotals.add(counterKey(row.payload.thread_token_usage));
        receiptTimes.add(JSON.stringify([row.timestamp, counterKey(row.payload.usage)]));
      } catch {}
    }
    let meta: z.infer<typeof sessionMetaPayloadSchema> | null = null;
    let model: string | null = null;
    let previousTotals: Record<string, number> | undefined;
    for (const line of records) {
      const envelope = codexEnvelopeSchema.safeParse(line);
      if (!envelope.success) continue;
      const { payload } = envelope.data;
      if (envelope.data.type === 'session_meta') {
        const sessionMeta = sessionMetaPayloadSchema.safeParse(payload);
        if (sessionMeta.success) meta = sessionMeta.data;
        continue;
      }
      if (envelope.data.type === 'turn_context') {
        const turnContext = turnContextPayloadSchema.safeParse(payload);
        if (turnContext.success) model = turnContext.data.model;
        continue;
      }
      if (envelope.data.type === 'token_usage_record' && meta && model) {
        const receipt = z
          .object({ response_id: z.string(), usage: z.record(z.string(), z.number()) })
          .safeParse(payload);
        if (receipt.success) {
          const u = receipt.data.usage;
          events.push({
            tool: 'codex',
            provider: 'openai',
            model,
            timestamp: envelope.data.timestamp,
            sessionId: meta.id,
            projectPath: meta.cwd,
            dedupKey: `codex:response:${receipt.data.response_id}`,
            tokens: {
              input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
              output: u.output_tokens ?? 0,
              cacheRead: u.cached_input_tokens ?? 0,
              cacheWrite: u.cache_write_input_tokens ?? 0,
            },
          });
        }
        continue;
      }
      if (envelope.data.type !== 'event_msg') continue;
      const tokenCount = tokenCountPayloadSchema.safeParse(payload);
      if (!tokenCount.success) continue;
      const info = tokenCount.data.info;
      if (!info) continue;
      if (!meta || !model) continue;
      const totals = info.total_token_usage;
      const signature = totals ? JSON.stringify(Object.entries(totals).sort()) : undefined;
      const previousSignature = previousTotals ? JSON.stringify(Object.entries(previousTotals).sort()) : undefined;
      if (totals && signature === previousSignature) continue;
      const reset = totals && previousTotals && (totals.input_tokens ?? 0) < (previousTotals.input_tokens ?? 0);
      const u =
        info.last_token_usage ??
        (totals
          ? Object.fromEntries(
              Object.entries(totals).map(([key, count]) => [
                key,
                Math.max(0, count - (reset ? 0 : (previousTotals?.[key] ?? 0))),
              ]),
            )
          : undefined);
      previousTotals = totals ?? previousTotals;
      if (!u) continue;
      if (
        (totals && receiptTotals.has(counterKey(totals))) ||
        receiptTimes.has(JSON.stringify([envelope.data.timestamp, counterKey(u)]))
      )
        continue;
      events.push({
        tool: 'codex',
        provider: 'openai',
        model,
        timestamp: envelope.data.timestamp,
        sessionId: meta.id,
        projectPath: meta.cwd,
        dedupKey: `codex:${meta.id}:${envelope.data.timestamp}:${signature ?? JSON.stringify(u)}`,
        tokens: {
          // input_tokens is inclusive of cached_input_tokens; subtract so cache reads aren't double-counted.
          input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
          // output_tokens already includes reasoning_output_tokens; don't add it again.
          output: u.output_tokens ?? 0,
          cacheRead: u.cached_input_tokens ?? 0,
          cacheWrite: 0,
        },
      });
    }
  }
  return events;
}
