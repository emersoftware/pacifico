import { antigravityTranscriptPath } from './antigravity-history';
import { listCursorIdeSessions } from './cursor-ide';
import { Glob } from 'bun';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getHome } from '../paths';
import { discoverOpencodeSessions } from '../opencode';
import { type Tool } from '../types';

export interface NativeSessionLocation {
  path: string;
  tool: Tool;
}

/** Enumerates native sources only. Archive retention is the importer's responsibility. */
export async function discoverNativeSessions(): Promise<NativeSessionLocation[]> {
  const home = getHome();
  const codex = process.env.SESSIONS_CODEX_DIR || join(home, '.codex/sessions');
  const cursor = process.env.SESSIONS_CURSOR_DIR || join(home, '.cursor');
  const antigravity = process.env.SESSIONS_ANTIGRAVITY_DIR || join(home, '.gemini');
  const roots: { path: string; pattern: string; tool: Tool }[] = [
    { path: process.env.SESSIONS_CLAUDE_DIR || join(home, '.claude/projects'), pattern: '*/*.jsonl', tool: 'claude' },
    {
      path: process.env.SESSIONS_CLAUDE_DIR || join(home, '.claude/projects'),
      pattern: '*/*/subagents/*.jsonl',
      tool: 'claude',
    },
    { path: codex, pattern: '**/*.jsonl{,.zst}', tool: 'codex' },
    {
      path: process.env.SESSIONS_CODEX_ARCHIVED_DIR || join(dirname(codex), 'archived_sessions'),
      pattern: '**/*.jsonl{,.zst}',
      tool: 'codex',
    },
    { path: antigravity, pattern: 'antigravity*/conversations/*.db', tool: 'antigravity' },
    { path: antigravity, pattern: 'antigravity*/brain/*/.git/HEAD', tool: 'antigravity' },
    { path: cursor, pattern: 'chats/*/*/store.db', tool: 'cursor' },
    { path: cursor, pattern: 'chats/*/store.db', tool: 'cursor' },
    { path: cursor, pattern: 'acp-sessions/*/store.db', tool: 'cursor' },
    { path: cursor, pattern: 'projects/*/agent-transcripts/**/*.jsonl', tool: 'cursor' },
    {
      path: antigravity,
      pattern: 'antigravity*/brain/*/.system_generated/logs/transcript{,_full}.jsonl',
      tool: 'antigravity',
    },
  ];
  const entries: NativeSessionLocation[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for await (const path of new Glob(root.pattern).scan({ cwd: root.path, absolute: true, dot: true })) {
      const identity =
        root.tool === 'antigravity'
          ? path.endsWith('/.git/HEAD')
            ? join(dirname(dirname(path)), '.system_generated/logs/transcript.jsonl')
            : path.endsWith('.db')
              ? antigravityTranscriptPath(path)
              : path.replace(/transcript_full\.jsonl$/, 'transcript.jsonl')
          : root.tool === 'codex'
            ? path.replace(/\.zst$/, '')
            : path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push({ path: identity, tool: root.tool });
    }
  }
  const cursorUser =
    process.env.SESSIONS_CURSOR_IDE_DIR ||
    (process.env.SESSIONS_CURSOR_DIR ? join(cursor, 'User') : join(home, 'Library/Application Support/Cursor/User'));
  if (existsSync(cursorUser)) {
    for await (const database of new Glob('**/state.vscdb').scan({
      cwd: cursorUser,
      absolute: true,
    })) {
      for (const session of listCursorIdeSessions(database)) {
        entries.push({ path: `${database}/${encodeURIComponent(session)}`, tool: 'cursor' });
      }
    }
  }
  entries.push(...discoverOpencodeSessions());
  return entries;
}
