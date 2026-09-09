import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCursorIde, listCursorIdeSessions } from './cursor-ide';

test('Cursor IDE preserves header order, raw bubbles, and missing-record status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-ide-'));
  const path = join(dir, 'state.vscdb');
  try {
    const db = new Database(path);
    db.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    const put = (key: string, value: unknown) =>
      db.run('INSERT INTO cursorDiskKV VALUES (?, ?)', [key, JSON.stringify(value)]);
    put('composerData:session', {
      name: 'Example',
      conversationHeaders: [{ bubbleId: 'u' }, { bubbleId: 'a' }, { bubbleId: 'missing' }],
    });
    put('bubbleId:session:a', {
      type: 2,
      text: 'answer',
      thinking: { text: 'native reasoning', signature: 'retained' },
      toolFormerData: { name: 'read_file', toolCallId: 'call-1', rawArgs: '{"target_file":"a.ts"}' },
    });
    put('bubbleId:session:u', {
      type: 1,
      rawText: 'question',
      workspaceProjectDir: '/explicit/project',
      timestamp: 1700000000000,
    });
    put('composerData:other', {
      conversation: [{ bubbleId: 'embedded', type: 2, thinking: { text: 'thought only' } }],
    });
    db.close();
    const before = readFileSync(path);
    expect(listCursorIdeSessions(path)).toEqual(['other', 'session']);
    expect(readCursorIde(path, 'missing')).toEqual([]);
    const thoughtOnly = readCursorIde(path, 'other')[0]!;
    expect(thoughtOnly.incomplete).toBe(false);
    expect(thoughtOnly.events[0]).toMatchObject({ text: '', thinking: 'thought only' });
    const sessions = readCursorIde(path, 'session');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cwd).toBe('/explicit/project');
    expect(sessions[0]!.events.map((e) => [e.role, e.text])).toEqual([
      ['user', 'question'],
      ['assistant', 'answer'],
    ]);
    expect(sessions[0]!.events[1]!.toolCalls).toEqual([
      { name: 'read_file', id: 'call-1', input: { target_file: 'a.ts' } },
    ]);
    expect(sessions[0]!.events[1]!.raw.toolFormerData).toEqual({
      name: 'read_file',
      toolCallId: 'call-1',
      rawArgs: '{"target_file":"a.ts"}',
    });
    expect(sessions[0]!.events[1]!.thinking).toBe('native reasoning');
    expect(sessions[0]!.events[1]!.raw.thinking).toEqual({ text: 'native reasoning', signature: 'retained' });
    expect(sessions[0]!.incomplete).toBe(true);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy Cursor containers preserve session membership and native message fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-legacy-'));
  const path = join(dir, 'state.vscdb');
  try {
    const db = new Database(path);
    db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const message = { id: 'a', type: 'ai', content: 'First answer', createdAt: 1000, extra: { kept: true } };
    db.run('INSERT INTO ItemTable VALUES (?, ?)', [
      'workbench.panel.aichat.view.aichat.chatdata',
      JSON.stringify({
        tabs: [
          { id: 'one', bubbles: [message] },
          { id: 'two', messages: [{ role: 'user', text: 'Separate question' }] },
        ],
      }),
    ]);
    db.close();
    const before = readFileSync(path);
    expect(listCursorIdeSessions(path)).toEqual(['legacy:one', 'legacy:two']);
    const sessions = readCursorIde(path);
    expect(sessions.map((s) => s.events.map((e) => e.text))).toEqual([['First answer'], ['Separate question']]);
    expect(sessions[0]!.events[0]!.raw).toEqual(message);
    expect(sessions[0]!.events[0]!.role).toBe('assistant');
    expect(sessions[0]!.events[0]!.timestamp).toBe('1970-01-01T00:00:01.000Z');
    expect(readCursorIde(path, 'legacy:two')).toHaveLength(1);
    expect(readCursorIde(path, 'missing')).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor capability tools retain native arguments and prefer bubble-local tool data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-cursor-capability-'));
  const path = join(dir, 'state.vscdb');
  try {
    const db = new Database(path);
    db.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    const oldTool = { name: 'read_file', rawArgs: '{unfinished', unknownField: 'retained' };
    const metadata = {
      version: 1,
      capabilities: [
        { type: 15, data: { bubbleDataMap: JSON.stringify({ old: oldTool, modern: oldTool }) } },
        { type: 9, data: { bubbleDataMap: '{invalid' } },
      ],
      conversation: [
        { bubbleId: 'old', type: 2, capabilityType: 15 },
        {
          bubbleId: 'modern',
          type: 2,
          capabilityType: 15,
          toolFormerData: { name: 'shell', rawArgs: '{"command":"pwd"}' },
        },
      ],
    };
    db.run('INSERT INTO cursorDiskKV VALUES (?, ?)', ['composerData:s', JSON.stringify(metadata)]);
    db.close();
    const before = readFileSync(path);
    const session = readCursorIde(path, 's')[0]!;
    expect(session.incomplete).toBe(false);
    expect(session.events[0]!.toolCalls).toEqual([{ name: 'read_file', input: '{unfinished' }]);
    expect(session.events[0]!.raw).toEqual(metadata.conversation[0]!);
    expect(session.events[0]!.variants).toEqual([{ source: 'cursor-capability', record: oldTool }]);
    expect(session.events[0]!.timestamp).toBeUndefined();
    expect(session.events[1]!.toolCalls).toEqual([{ name: 'shell', input: { command: 'pwd' } }]);
    expect(session.metadata).toEqual(metadata);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workspace composers preserve explicit conversation order and native metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-workspace-composer-'));
  const path = join(dir, 'state.vscdb');
  try {
    const db = new Database(path);
    db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
    const metadata = {
      composerId: 'old',
      name: 'Native title',
      conversation: [
        { type: 1, text: 'question', extra: 'retained' },
        { type: 2, text: 'answer', bubbleId: 'a' },
        { type: 99, text: 'unknown event' },
      ],
    };
    db.run('INSERT INTO ItemTable VALUES (?, ?)', [
      'composer.composerData',
      JSON.stringify({ allComposers: [metadata] }),
    ]);
    db.close();
    const before = readFileSync(path);
    expect(listCursorIdeSessions(path)).toEqual(['workspace:old']);
    const session = readCursorIde(path, 'workspace:old')[0]!;
    expect(session.metadata).toEqual(metadata);
    expect(session.events.map((event) => event.role)).toEqual(['user', 'assistant', 'unknown']);
    expect(session.events.map((event) => event.raw)).toEqual(metadata.conversation);
    expect(session.incomplete).toBe(false);
    expect(readCursorIde(path, 'workspace:missing')).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
