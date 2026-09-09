import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverNativeSessions } from './discovery';

test('discovery includes Codex archived sessions and keeps native locations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-discovery-'));
  const env = {
    SESSIONS_HOME: root,
    SESSIONS_CLAUDE_DIR: join(root, '.claude/projects'),
    SESSIONS_CODEX_DIR: join(root, '.codex/sessions'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(root, '.codex/archived_sessions'),
    SESSIONS_CURSOR_DIR: join(root, '.cursor'),
    SESSIONS_OPENCODE_DB: join(root, 'absent.db'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const files = [
      '.codex/sessions/2026/09/active.jsonl',
      '.codex/archived_sessions/archived.jsonl',
      '.claude/projects/project/session.jsonl',
      '.claude/projects/project/session/subagents/agent-child.jsonl',
      '.cursor/chats/019bfb99773577a08790176cdc56fda7/store.db',
      '.cursor/chats/workspace/session/store.db',
      '.cursor/acp-sessions/acp-session/store.db',
    ];
    for (const file of files) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{}\n');
    }
    const result = await discoverNativeSessions();
    expect(result.map((e) => e.path).sort()).toEqual(files.map((file) => join(root, file)).sort());
    expect(result.filter((e) => e.tool === 'codex')).toHaveLength(2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
