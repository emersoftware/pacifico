import { zstdCompressSync } from 'node:zlib';
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { closeDb, refreshIndex, searchSessions, clearCache } from '../cache';
import { readSessionLines, statSession } from '../session-io';
import { searchNativeDocuments, readNativeDocument } from '../retrieval/documents';
import { antigravityDatabasePath } from './antigravity-history';
import { loadManifest } from '../vault/archive';
import { discoverNativeSessions } from './discovery';
import { getSessionMessages } from '../parser';

test('Cursor and Antigravity survive native deletion and an index rebuild', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-import-'));
  const env = {
    SESSIONS_HOME: home,
    SESSIONS_NATIVE_HOME: home,
    SESSIONS_CACHE_DIR: join(home, 'cache'),
    SESSIONS_ARCHIVE_DIR: join(home, 'archive'),
    SESSIONS_CLAUDE_DIR: join(home, 'claude'),
    SESSIONS_CODEX_DIR: join(home, 'codex'),
    SESSIONS_CODEX_ARCHIVED_DIR: join(home, 'codex-archived'),
    SESSIONS_OPENCODE_DB: join(home, 'opencode.db'),
    SESSIONS_CURSOR_DIR: join(home, 'cursor'),
    SESSIONS_ANTIGRAVITY_DIR: join(home, 'gemini'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  closeDb();
  try {
    const cursor = join(env.SESSIONS_CURSOR_DIR, 'acp-sessions', 'cursor-session', 'store.db');
    mkdirSync(dirname(cursor), { recursive: true });
    const db = new Database(cursor);
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)',
    );
    db.query('INSERT INTO meta VALUES (?, ?)').run(
      '0',
      JSON.stringify({ agentId: 'cursor-session', latestRootBlobId: 'root' }),
    );
    db.query('INSERT INTO blobs VALUES (?, ?)').run(
      'root',
      Buffer.from(JSON.stringify({ role: 'user', content: 'quartzretention from Cursor' })),
    );
    db.close();
    const cursorIde = join(env.SESSIONS_CURSOR_DIR, 'User/globalStorage/state.vscdb');
    mkdirSync(dirname(cursorIde), { recursive: true });
    const ide = new Database(cursorIde);
    ide.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
    ide.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [
      'composerData:ide-session',
      JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: 'user' }, { bubbleId: 'tool' }],
        capabilities: [
          {
            type: 15,
            data: {
              bubbleDataMap: JSON.stringify({
                tool: { name: 'read_file', rawArgs: '{"path":"legacy.ts"}', nativeExtra: 'preserve' },
              }),
            },
          },
        ],
      }),
    ]);
    ide.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [
      'bubbleId:ide-session:user',
      JSON.stringify({ type: 1, text: 'quartzretention from Cursor IDE' }),
    ]);
    ide.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [
      'bubbleId:ide-session:tool',
      JSON.stringify({ type: 2, capabilityType: 15 }),
    ]);
    ide.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    ide.run('INSERT INTO ItemTable VALUES (?, ?)', [
      'workbench.panel.aichat.view.aichat.chatdata',
      JSON.stringify({
        chatSessions: [
          { id: 'old-session', messages: [{ role: 'user', content: 'quartzretention from legacy Cursor' }] },
        ],
      }),
    ]);
    ide.close();
    const workspaceDbPath = join(env.SESSIONS_CURSOR_DIR, 'User/workspaceStorage/project/state.vscdb');
    mkdirSync(dirname(workspaceDbPath), { recursive: true });
    const workspaceDb = new Database(workspaceDbPath);
    workspaceDb.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const workspaceComposer = {
      composerId: 'workspace-session',
      name: 'Native workspace title',
      conversation: [
        { type: 1, text: 'workspacequartz', context: { native: true } },
        { type: 2, text: 'workspace answer' },
      ],
    };
    workspaceDb.run('INSERT INTO ItemTable VALUES (?, ?)', [
      'composer.composerData',
      JSON.stringify({ allComposers: [workspaceComposer] }),
    ]);
    workspaceDb.close();
    const workspaceBytes = readFileSync(workspaceDbPath);

    const antigravity = join(
      env.SESSIONS_ANTIGRAVITY_DIR,
      'antigravity-cli/brain/ag-session/.system_generated/logs/transcript_full.jsonl',
    );
    mkdirSync(dirname(antigravity), { recursive: true });
    writeFileSync(
      antigravity,
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-09-08T10:00:00Z',
        content: 'quartzretention from Antigravity',
      }),
    );
    const agDatabase = antigravityDatabasePath(antigravity.replace('transcript_full.jsonl', 'transcript.jsonl'));
    mkdirSync(dirname(agDatabase), { recursive: true });
    const agStore = new Database(agDatabase);
    agStore.exec(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, step_payload BLOB); CREATE TABLE trajectory_meta (trajectory_id TEXT)',
    );
    const extra = Buffer.from('databasequartz');
    agStore.run('INSERT INTO steps VALUES (1, 15, 3, 0, ?)', [
      Buffer.from([8, 15, 32, 3, 162, 1, extra.length + 2, 10, extra.length, ...extra]),
    ]);
    agStore.close();
    const memory = join(home, '.codex/memories');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'MEMORY.md'), 'nativequartz memory');
    const child = join(env.SESSIONS_CLAUDE_DIR, 'project', 'parent', 'subagents', 'agent-child.jsonl');
    mkdirSync(dirname(child), { recursive: true });
    const childContent = JSON.stringify({
      type: 'assistant',
      sessionId: 'parent',
      agentId: 'child',
      isSidechain: true,
      cwd: '/claude/project',
      message: { role: 'assistant', content: [{ type: 'text', text: 'childquartz answer' }] },
    });
    writeFileSync(child, childContent);
    const codexPlain = join(env.SESSIONS_CODEX_DIR, 'rollout-compressed.jsonl');
    mkdirSync(dirname(codexPlain), { recursive: true });
    const codexContent =
      JSON.stringify({ type: 'session_meta', payload: { id: 'compressed', cwd: '/codex/project' } }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compressedquartz' }] },
      });
    writeFileSync(codexPlain + '.zst', zstdCompressSync(Buffer.from(codexContent)));
    const originals = [cursor, cursorIde, antigravity].map((path) => readFileSync(path));
    expect((await discoverNativeSessions()).filter((s) => s.tool === 'cursor')).toHaveLength(4);
    expect(readSessionLines(cursorIde + '/ide-session', 'cursor').join('\n')).toContain('quartzretention');
    await refreshIndex();
    expect(await searchSessions('compressedquartz')).toMatchObject([{ sessionId: 'compressed' }]);
    expect(loadManifest(env.SESSIONS_ARCHIVE_DIR)[codexPlain]?.sessionId).toBe('compressed');
    expect(await searchSessions('childquartz')).toMatchObject([{ sessionId: 'parent/subagents/agent-child' }]);
    expect(readFileSync(loadManifest(env.SESSIONS_ARCHIVE_DIR)[child]!.vaultPath, 'utf8')).toBe(childContent);
    rmSync(env.SESSIONS_CLAUDE_DIR, { recursive: true });
    writeFileSync(codexPlain, codexContent);
    await refreshIndex();
    expect(await searchSessions('compressedquartz')).toMatchObject([{ sessionId: 'compressed' }]);
    expect(loadManifest(env.SESSIONS_ARCHIVE_DIR)[codexPlain]?.sessionId).toBe('compressed');
    rmSync(codexPlain);
    writeFileSync(codexPlain + '.zst', 'invalid compressed stream');
    await refreshIndex();
    expect(await searchSessions('compressedquartz')).toMatchObject([{ sessionId: 'compressed' }]);
    expect(loadManifest(env.SESSIONS_ARCHIVE_DIR)[codexPlain]?.sessionId).toBe('compressed');
    expect(readSessionLines(codexPlain, 'codex').join('\n')).toContain('compressedquartz');
    rmSync(codexPlain + '.zst');
    const found = await searchSessions('quartzretention');
    expect(found.map((row) => row.tool).sort()).toEqual(['antigravity', 'cursor', 'cursor', 'cursor']);
    expect(found.map((row) => row.sessionId).sort()).toEqual([
      'ag-session',
      'cursor-session',
      'ide-session',
      'legacy:old-session',
    ]);
    expect(found.every((row) => row.cwd === '')).toBe(true);
    const manifest = loadManifest(env.SESSIONS_ARCHIVE_DIR);
    for (const row of found) expect(manifest[row.filePath]?.sessionId).toBe(row.sessionId);
    expect((await searchSessions('databasequartz'))[0]?.sessionId).toBe('ag-session');
    const history = join(env.SESSIONS_ANTIGRAVITY_DIR, 'antigravity-cli/history.jsonl');
    writeFileSync(history, JSON.stringify({ conversationId: 'ag-session', workspace: '/explicit/project' }));
    await refreshIndex();
    expect((await searchSessions('quartzretention', { tool: 'antigravity' }))[0]?.cwd).toBe('/explicit/project');
    for (const [index, path] of [cursor, cursorIde, antigravity].entries())
      expect(readFileSync(path)).toEqual(originals[index]!);
    const retainedDatabase = new Database(cursorIde);
    retainedDatabase.run("DELETE FROM cursorDiskKV WHERE key = 'composerData:ide-session'");
    retainedDatabase.run('DELETE FROM ItemTable');
    retainedDatabase.close();
    await refreshIndex();
    const retained = (await searchSessions('quartzretention')).find((row) => row.sessionId === 'ide-session');
    expect(retained).toBeDefined();
    expect(readSessionLines(retained!.filePath).join('\n')).toContain('quartzretention from Cursor IDE');
    const legacyRetained = (await searchSessions('quartzretention')).find(
      (row) => row.sessionId === 'legacy:old-session',
    );
    expect(legacyRetained).toBeDefined();
    expect(readSessionLines(legacyRetained!.filePath).join('\n')).toContain('quartzretention from legacy Cursor');
    const workspaceHit = (await searchSessions('workspacequartz'))[0]!;
    expect(workspaceHit.sessionId).toBe('workspace:workspace-session');
    expect(readFileSync(workspaceDbPath)).toEqual(workspaceBytes);
    const workspaceSnapshot = readSessionLines(workspaceHit.filePath, 'cursor');
    const remainingWorkspace = new Database(workspaceDbPath);
    remainingWorkspace.run('UPDATE ItemTable SET value = ? WHERE key = ?', [
      JSON.stringify({ allComposers: [] }),
      'composer.composerData',
    ]);
    remainingWorkspace.close();
    await refreshIndex();
    expect((await searchSessions('workspacequartz'))[0]?.sessionId).toBe('workspace:workspace-session');
    expect(readSessionLines(workspaceHit.filePath, 'cursor')).toEqual(workspaceSnapshot);
    rmSync(env.SESSIONS_CURSOR_DIR, { recursive: true });
    rmSync(antigravity);
    await refreshIndex();
    const databaseOnly = await searchSessions('databasequartz');
    expect(databaseOnly[0]?.sessionId).toBe('ag-session');
    expect(readSessionLines(databaseOnly[0]!.filePath).join('\n')).toContain('databasequartz');
    rmSync(agDatabase);
    const archivedAg = loadManifest(env.SESSIONS_ARCHIVE_DIR)[
      found.find((row) => row.tool === 'antigravity')!.filePath
    ]!;
    const beforeHistoryChange = statSession(found.find((row) => row.tool === 'antigravity')!.filePath, 'antigravity');
    writeFileSync(history, 'unrelated history after source deletion');
    expect(statSession(found.find((row) => row.tool === 'antigravity')!.filePath, 'antigravity')).toEqual(
      beforeHistoryChange,
    );
    expect(readFileSync(archivedAg.vaultPath, 'utf8')).toContain('databasequartz');
    rmSync(env.SESSIONS_ANTIGRAVITY_DIR, { recursive: true });
    rmSync(memory, { recursive: true });
    closeDb();
    clearCache();
    await refreshIndex();
    expect(await searchSessions('compressedquartz')).toMatchObject([{ sessionId: 'compressed' }]);
    expect(loadManifest(env.SESSIONS_ARCHIVE_DIR)[codexPlain]?.sessionId).toBe('compressed');
    expect(await searchSessions('childquartz')).toMatchObject([{ sessionId: 'parent/subagents/agent-child' }]);
    expect(readSessionLines(child, 'claude').join('\n')).toBe(childContent);
    const rebuilt = await searchSessions('quartzretention');
    expect(rebuilt).toHaveLength(4);
    const recoveredWorkspace = (await searchSessions('workspacequartz'))[0]!;
    expect(recoveredWorkspace.sessionId).toBe('workspace:workspace-session');
    expect(readSessionLines(recoveredWorkspace.filePath, 'cursor')).toEqual(workspaceSnapshot);
    expect(JSON.parse(workspaceSnapshot[0]!).metadata).toEqual(workspaceComposer);
    const rebuiltCursor = rebuilt.find((row) => row.sessionId === 'ide-session')!;
    const toolRecord = readSessionLines(rebuiltCursor.filePath, 'cursor')
      .map((line) => JSON.parse(line))
      .find((record) => record.source?.id === 'tool');
    expect(toolRecord.message.content).toEqual([{ type: 'tool_use', name: 'read_file', input: { path: 'legacy.ts' } }]);
    expect(toolRecord.source.raw).toEqual({ type: 2, capabilityType: 15 });
    expect(toolRecord.source.variants).toEqual([
      {
        source: 'cursor-capability',
        record: {
          name: 'read_file',
          rawArgs: '{"path":"legacy.ts"}',
          nativeExtra: 'preserve',
        },
      },
    ]);
    expect((await searchSessions('databasequartz'))[0]?.sessionId).toBe('ag-session');
    const index = new Database(join(env.SESSIONS_CACHE_DIR, 'index.db'), { readonly: true });
    expect(
      index
        .query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'nativequartz'")
        .get(),
    ).toEqual({ count: 1 });
    index.close();
    const hits = await searchNativeDocuments('nativequartz');
    expect(hits).toHaveLength(1);
    const hit = hits[0] as { id: string };
    const page = await readNativeDocument(hit.id, 0, 6);
    expect(page?.content).toBe('native');
    expect(page?.truncated).toBe(true);
    expect(page?.harness).toBe('codex');
    await expect(readNativeDocument(hit.id, -1)).rejects.toThrow('offset');
    expect(rebuilt.find((row) => row.tool === 'antigravity')?.cwd).toBe('/explicit/project');
    for (const row of rebuilt) {
      expect(getSessionMessages(readSessionLines(row.filePath))[0]?.text).toContain('quartzretention');
    }
  } finally {
    closeDb();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
