import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactTranscript, archiveSummary } from './compact';
import { archiveFile, saveManifest, migrateArchive, type Manifest, loadManifest } from './archive';
import { readArchive } from './blob';
import { collectArchiveObjects, compactArchive } from './maintenance';
import { extractMessages } from '../parser';
import { gatherEvents } from '../report/extract';

const stamp = '2026-10-01T10:00:00.000Z';
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const codex = (extra: unknown[] = []) =>
  jsonl([
    {
      type: 'session_meta',
      timestamp: stamp,
      payload: { id: 's1', cwd: '/repo', instructions: 'internal instructions' },
    },
    { type: 'turn_context', timestamp: stamp, payload: { model: 'gpt-5.5', sandbox_policy: { network: true } } },
    {
      type: 'response_item',
      timestamp: stamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the widget' }] },
    },
    {
      type: 'response_item',
      timestamp: stamp,
      payload: { type: 'function_call', call_id: 'call1', name: 'exec_command', arguments: '{"cmd":"git status"}' },
    },
    {
      type: 'response_item',
      timestamp: stamp,
      payload: { type: 'function_call_output', call_id: 'call1', output: 'clean' },
    },
    ...extra,
    {
      type: 'response_item',
      timestamp: '2026-10-01T10:00:05.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
    },
  ]);
const token = {
  type: 'event_msg',
  timestamp: stamp,
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30 },
      last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 10 },
    },
  },
};

test('compaction preserves conversations and complete tool arguments/results, with disjoint token totals', () => {
  const raw = codex([
    token,
    token,
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque' } },
  ]);
  const compact = compactTranscript(raw, 'codex');
  expect(extractMessages(compact.split('\n'))).toEqual(extractMessages(raw.split('\n')));
  expect(compact).toContain('git status');
  expect(compact).toContain('clean');
  expect(compact).not.toContain('opaque');
  expect(compact).not.toContain('sandbox_policy');
  const summary = archiveSummary(compact.trimEnd().split('\n'))!;
  expect(summary.tokens).toMatchObject({ input: 70, output: 20, cacheRead: 30 });
  expect(summary.usage).toHaveLength(1);
  expect(summary.elapsedMs).toBe(5000);
  expect(summary.recordedExecutionMs).toBeNull();
  expect(summary.estimatedCostUSD).toBeGreaterThan(0);
  expect(compactTranscript(compact, 'codex')).toBe(compact);
});

test('per-response Codex receipts replace UI counters and deduplicate repeated responses', () => {
  const receipt = {
    type: 'token_usage_record',
    timestamp: stamp,
    payload: {
      response_id: 'resp1',
      usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 10 },
    },
  };
  const compact = compactTranscript(codex([token, receipt, receipt]), 'codex');
  const summary = archiveSummary(compact.trimEnd().split('\n'))!;
  expect(summary.usage).toHaveLength(1);
  expect(summary.tokens).toMatchObject({ input: 70, output: 20, cacheRead: 30 });
});

test('Claude records usage once, retains tool results and counts duration separately from elapsed time', () => {
  const assistant = {
    type: 'assistant',
    sessionId: 'claude1',
    cwd: '/repo',
    timestamp: stamp,
    requestId: 'request1',
    message: {
      id: 'message1',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 },
      content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'pwd' } },
      ],
    },
  };
  const duration = { type: 'system', subtype: 'turn_duration', timestamp: stamp, durationMs: 123 };
  const raw = jsonl([
    assistant,
    assistant,
    {
      type: 'user',
      sessionId: 'claude1',
      cwd: '/repo',
      timestamp: stamp,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '/repo' }] },
    },
    duration,
    duration,
  ]);
  const compact = compactTranscript(raw, 'claude');
  const summary = archiveSummary(compact.trimEnd().split('\n'))!;
  expect(summary.tokens).toMatchObject({ input: 10, output: 20, cacheRead: 40, cacheWrite: 30 });
  expect(summary.recordedExecutionMs).toBe(123);
  expect(compact).toContain('tool_result');
  expect(compact).not.toContain('turn_duration');
  expect(extractMessages(compact.split('\n'))).toEqual(extractMessages(raw.split('\n')));
});

test('unrecognized records and malformed snapshots are not silently discarded', () => {
  const compact = compactTranscript(codex([{ type: 'future_message', body: 'unique evidence' }]), 'codex');
  expect(compact).toContain('unique evidence');
  expect(archiveSummary(compact.trimEnd().split('\n'))!.unclassifiedRecords).toBe(1);
  expect(() => compactTranscript('{broken', 'codex')).toThrow();
});

test('content-addressed migration shares aliases, preserves unknown orphans and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-compact-'));
  try {
    const legacy = join(dir, 'legacy.jsonl');
    const orphan = join(dir, 'unknown.jsonl');
    writeFileSync(legacy, codex([token]));
    writeFileSync(orphan, 'unique');
    const entry = {
      tool: 'codex' as const,
      cwd: '/repo',
      sessionId: 's1',
      mtime: 1,
      size: 100,
      archivedAt: stamp,
      vaultPath: legacy,
    };
    const manifest: Manifest = { '/gone/session': { ...entry }, '/gone/archive': { ...entry } };
    saveManifest(dir, manifest);
    expect((await compactArchive(dir, false)).pending).toBe(2);
    expect(readFileSync(legacy, 'utf8')).toContain('sandbox_policy');
    expect(migrateArchive(dir, manifest, 1)).toBe(1);
    saveManifest(dir, manifest);
    expect(existsSync(legacy)).toBe(true);
    expect(migrateArchive(dir, manifest, 1)).toBe(1);
    saveManifest(dir, manifest);
    expect(existsSync(legacy)).toBe(false);
    expect(manifest['/gone/session']!.vaultPath).toBe(manifest['/gone/archive']!.vaultPath);
    expect(readArchive(manifest['/gone/session']!.vaultPath)).toContain('pacifico_summary');
    expect(migrateArchive(dir, manifest, 10)).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(loadManifest(dir)).toEqual(manifest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('obsolete managed objects are collected after the reader grace period, only after manifest commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-gc-'));
  try {
    const m: Manifest = {};
    const source = join(dir, '..', 'native-source');
    archiveFile(
      { path: source, tool: 'codex' },
      { cwd: '/repo', sessionId: 's1' },
      { mtime: 1, size: 1 },
      m,
      dir,
      codex(),
    );
    saveManifest(dir, m);
    const old = m[source]!.vaultPath;
    archiveFile(
      { path: source, tool: 'codex' },
      { cwd: '/repo', sessionId: 's1' },
      { mtime: 2, size: 2 },
      m,
      dir,
      codex([{ type: 'user_message', text: 'new' }]),
    );
    expect(existsSync(old)).toBe(true);
    saveManifest(dir, m);
    expect(collectArchiveObjects(dir, m)).toBe(0);
    utimesSync(old, 1, 1);
    expect(collectArchiveObjects(dir, m)).toBe(1);
    expect(existsSync(m[source]!.vaultPath)).toBe(true);
    expect(existsSync(old + '.summary.json')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report accounting survives native source deletion and shared archive aliases count once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-accounting-'));
  try {
    const archive = join(dir, 'archive');
    const native = join(dir, 'codex');
    mkdirSync(native);
    const source = join(native, 'session.jsonl');
    const text = codex([token]);
    writeFileSync(source, text);
    const manifest: Manifest = {};
    archiveFile(
      { path: source, tool: 'codex' },
      { cwd: '/repo', sessionId: 's1' },
      { mtime: 1, size: text.length },
      manifest,
      archive,
      text,
    );
    manifest['/old/path'] = { ...manifest[source]! };
    saveManifest(archive, manifest);
    const roots = { codex: native, claudeCode: join(dir, 'missing') };
    const live = await gatherEvents(roots, undefined, { noCache: true, archiveDir: archive });
    expect(live).toHaveLength(1);
    rmSync(source);
    const archived = await gatherEvents(roots, undefined, { noCache: true, archiveDir: archive });
    expect(archived).toEqual(live);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mixed Codex formats retain earlier usage while deduplicating modern counter twins', () => {
  const modern = {
    type: 'token_usage_record',
    timestamp: '2026-10-01T10:00:02.000Z',
    payload: {
      response_id: 'new-response',
      usage: { input_tokens: 50, output_tokens: 5 },
      thread_token_usage: { input_tokens: 150, output_tokens: 25, cached_input_tokens: 30 },
    },
  };
  const twin = {
    type: 'event_msg',
    timestamp: '2026-10-01T10:00:01.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 50, output_tokens: 5 },
        total_token_usage: { input_tokens: 150, output_tokens: 25, cached_input_tokens: 30 },
      },
    },
  };
  const compact = compactTranscript(codex([token, twin, modern]), 'codex');
  expect(archiveSummary(compact.trimEnd().split('\n'))!.tokens).toMatchObject({
    input: 120,
    output: 25,
    cacheRead: 30,
  });
});

test('invalid manifests abort maintenance without collecting existing evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacifico-invalid-manifest-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), '{invalid');
    await expect(compactArchive(dir, true)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
