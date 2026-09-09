import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { antigravityWorkspace } from './antigravity-history';

test('Antigravity workspace attribution requires an explicit matching conversation id', () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-ag-history-'));
  const source = join(root, 'history.jsonl');
  const transcript = join(root, 'brain/session/.system_generated/logs/transcript.jsonl');
  try {
    writeFileSync(
      source,
      [
        { conversationId: '', workspace: '/unassigned' },
        { conversationId: 'other', workspace: '/other' },
        { conversationId: 'session', workspace: '/actual/project' },
        { conversationId: 'session', workspace: 'relative-invalid' },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n{partial',
    );
    expect(antigravityWorkspace(transcript, 'session')).toEqual({ cwd: '/actual/project', source });
    expect(antigravityWorkspace(transcript, 'missing')).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
