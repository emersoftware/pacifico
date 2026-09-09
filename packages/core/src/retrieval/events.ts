import { createHash } from 'node:crypto';
import { readSessionLines } from '../session-io';

/** Pages archived JSONL records independently of searchable message numbering. */
export function readSessionEvents(
  filePath: string,
  offset = 0,
  limit = 20,
  characterOffset = 0,
  expectedVersion?: string,
) {
  return pageSessionEvents(readSessionLines(filePath), offset, limit, characterOffset, expectedVersion);
}

/** Shared record pagination for local archives and server snapshots. */
export function pageSessionEvents(
  lines: string[],
  offset = 0,
  limit = 20,
  characterOffset = 0,
  expectedVersion?: string,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(characterOffset) || characterOffset < 0)
    throw new Error('Offsets must be nonnegative integers.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100.');
  if (lines.length === 0) throw new Error('Session is missing or unreadable.');
  const records = lines.filter((line) => line.trim());
  const version = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  if (expectedVersion !== undefined && expectedVersion !== version)
    throw new Error('Session changed between pages. Restart from offset 0 without a version.');
  let remaining = 20_000;
  let index = offset;
  let start = characterOffset;
  const events: { index: number; characterOffset: number; text: string; complete: boolean }[] = [];
  if (start > (records[index]?.length ?? 0)) throw new Error('characterOffset exceeds the selected record.');
  while (index < records.length && events.length < limit && remaining > 0) {
    const record = records[index]!;
    const text = record.slice(start, start + remaining);
    const complete = start + text.length >= record.length;
    events.push({ index, characterOffset: start, text, complete });
    remaining -= text.length;
    if (!complete) {
      start += text.length;
      break;
    }
    index++;
    start = 0;
  }
  return {
    version,
    total: records.length,
    events,
    next: index < records.length ? { offset: index, characterOffset: start, version } : null,
  };
}
