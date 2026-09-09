import { readAntigravityGit } from '../sources/antigravity-git';
import { projectSession } from './session-projection';
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { cursorIdeLocation, readCursorIde } from '../sources/cursor-ide';
import { readCursorStore } from '../sources/cursor-store';
import { parseCursorTranscript } from '../sources/cursor-transcript';
import { parseAntigravityTranscript, mergeAntigravityTranscripts } from '../sources/antigravity-transcript';
import { readAntigravityStore, mergeAntigravitySteps } from '../sources/antigravity-store';
import { antigravityWorkspace, antigravityDatabasePath } from '../sources/antigravity-history';
import { type SourceEvent } from '../sources/records';

/** Materializes native events into the index's transcript projection, retaining original records. */
export function readImportedSession(
  path: string,
  harness: 'cursor' | 'antigravity',
  previous: string[] = [],
): string[] {
  let events: SourceEvent[];
  let metadata: Record<string, unknown> = {};
  let sourceCwd: string | undefined;
  let id = basename(path).replace(/\.jsonl$/, '');
  const ide = harness === 'cursor' ? cursorIdeLocation(path) : null;
  if (ide) {
    const session = readCursorIde(ide.database, ide.id)[0];
    if (!session || session.incomplete) throw new Error('Cursor IDE conversation is missing or incomplete');
    events = session.events;
    metadata = session.metadata;
    sourceCwd = session.cwd;
    id = session.id;
  } else if (harness === 'cursor' && basename(path) === 'store.db') {
    const store = readCursorStore(path);
    if (store.incomplete) throw new Error('Cursor conversation graph is incomplete');
    events = store.events;
    metadata = store.metadata;
    id = typeof metadata.agentId === 'string' ? metadata.agentId : basename(dirname(path));
  } else {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (harness !== 'antigravity' || basename(path) !== 'transcript.jsonl') throw error;
    }
    const lines = text.trimEnd().split('\n');
    try {
      if (JSON.parse(lines[0]!).pacifico === 1) return lines;
    } catch {}
    if (harness === 'antigravity' && basename(path) === 'transcript.jsonl') {
      let full = '';
      try {
        full = readFileSync(path.replace(/transcript\.jsonl$/, 'transcript_full.jsonl'), 'utf8');
      } catch {}
      events = mergeAntigravityTranscripts(text, full, readAntigravityGit(path)).events;
      const database = antigravityDatabasePath(path);
      if (existsSync(database)) {
        const stored = readAntigravityStore(database);
        events = mergeAntigravitySteps(stored.events, events);
        metadata = { database, trajectories: stored.metadata, auxiliary: stored.auxiliary };
      }
    } else {
      events = (harness === 'cursor' ? parseCursorTranscript(text) : parseAntigravityTranscript(text)).events;
    }
    if (harness === 'antigravity') {
      id = basename(dirname(dirname(dirname(path))));
      const workspace = antigravityWorkspace(path, id);
      if (workspace) metadata = { ...metadata, cwd: workspace.cwd, workspaceSource: workspace.source };
    }
  }
  if (!events.length) return [];
  const cwd = sourceCwd ?? (typeof metadata.cwd === 'string' ? metadata.cwd : '');
  if (harness === 'antigravity' && previous.length) {
    const current = new Map(events.map((event) => [event.id, event]));
    for (const line of previous) {
      try {
        const record = JSON.parse(line);
        if (record.pacifico !== 1 || record.type !== 'message') continue;
        const event = current.get(record.source?.id);
        if (!event) continue;
        const variants = [...(event.variants ?? [])];
        const seen = new Set([JSON.stringify(event.raw), ...variants.map((v) => JSON.stringify(v.record))]);
        const older = [{ source: 'previous-archive', record: record.source.raw }, ...(record.source.variants ?? [])];
        for (const variant of older) {
          const signature = JSON.stringify(variant.record);
          if (signature !== undefined && !seen.has(signature)) {
            variants.push(variant);
            seen.add(signature);
          }
        }
        if (variants.length) event.variants = variants;
      } catch {}
    }
  }
  const lines = projectSession(id, cwd, metadata, events);
  if (harness === 'antigravity' && previous.length) {
    const present = new Set(events.map((event) => event.id));
    const retained: string[] = [];
    for (const line of previous) {
      try {
        const record = JSON.parse(line);
        const id = record.source?.id;
        if (record.pacifico === 1 && record.type === 'message' && typeof id === 'string' && !present.has(id)) {
          retained.push(line);
          present.add(id);
        }
      } catch {}
    }
    if (retained.length) {
      const headers = lines.filter((line) => JSON.parse(line).type !== 'message');
      const messages = [...lines.filter((line) => JSON.parse(line).type === 'message'), ...retained];
      messages.sort((a, b) => Number(JSON.parse(a).source.id) - Number(JSON.parse(b).source.id));
      return [...headers, ...messages];
    }
  }
  return lines;
}
