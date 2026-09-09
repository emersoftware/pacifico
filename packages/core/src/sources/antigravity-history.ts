import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, basename } from 'node:path';

export function antigravityHistoryPath(transcript: string): string {
  return join(dirname(dirname(dirname(dirname(dirname(transcript))))), 'history.jsonl');
}

/** Reads explicit conversation-to-workspace mappings from the same native store. */
export function antigravityWorkspace(transcript: string, sessionId: string): { cwd: string; source: string } | null {
  const source = antigravityHistoryPath(transcript);
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch {
    return null;
  }
  let cwd = '';
  for (const line of text.split('\n')) {
    try {
      const row = JSON.parse(line);
      if (row?.conversationId === sessionId && typeof row.workspace === 'string' && isAbsolute(row.workspace))
        cwd = row.workspace;
    } catch {}
  }
  return cwd ? { cwd, source } : null;
}

export function antigravityDatabasePath(transcript: string): string {
  return join(
    dirname(antigravityHistoryPath(transcript)),
    'conversations',
    basename(dirname(dirname(dirname(transcript)))) + '.db',
  );
}

export function antigravityTranscriptPath(database: string): string {
  return join(
    dirname(dirname(database)),
    'brain',
    basename(database, '.db'),
    '.system_generated/logs/transcript.jsonl',
  );
}
