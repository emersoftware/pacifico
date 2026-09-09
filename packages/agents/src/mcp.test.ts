import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { version as pkgVersion } from '../../../package.json';
import { asJsonObject, asJsonString, type JsonValue } from '@pacifico/core/extract-util';
import { SearchOutput, ReadSessionOutput, ContextOutput } from './mcp-schemas';

const j = (o: JsonValue): string => JSON.stringify(o);

/** The first text block of a tool result; fails loudly when the result carries none.
 *  `content` is unknown-typed through the SDK's loose `[x: string]: unknown` catchall. */
/** What client.callTool resolves to (a standard result or a task wrapper). */
type ToolCallOutcome = Awaited<ReturnType<Client['callTool']>>;

function firstText(res: ToolCallOutcome | undefined): string {
  const content = res?.content;
  if (!Array.isArray(content)) throw new Error('no content blocks');
  const first = asJsonObject(content[0]);
  if (first?.type !== 'text') throw new Error('expected a text content block');
  const text = asJsonString(first.text);
  if (text === undefined) throw new Error('text block without text');
  return text;
}

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run. So we (re)assert our env and reset the cached DB
// connection before each test - keeping this file hermetic regardless of which other
// cache-importing file (cache.search.test.ts, context.test.ts) ran first or interleaves.
const originalNativeHome = process.env.SESSIONS_NATIVE_HOME;
let tmp: string;
let mcp: typeof import('./mcp');
let cache: typeof import('@pacifico/core/cache');

/**
 * This repo, and therefore a real git repo `resolveRepo` will resolve. Sessions D and E
 * below are indexed under it so `get_context_primer` has something to return - a temp
 * mkdtemp dir is not a repo, and calling the primer against one only ever exercises the
 * not-a-repo sentinel.
 *
 * realpathSync because git reports `--show-toplevel` resolved (macOS /var -> /private/var),
 * and `getContextPrimer` matches the indexed `cwd` against that resolved container exactly.
 */
const REPO_ROOT = realpathSync(join(import.meta.dir, '..'));

function setEnv(): void {
  process.env.SESSIONS_CACHE_DIR = join(tmp, 'cache');
  process.env.SESSIONS_CLAUDE_DIR = join(tmp, 'claude');
  process.env.SESSIONS_NATIVE_HOME = join(tmp, 'native');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  // Keep durable session archives inside the fixture.
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data');
  // Shadow any leaked SESSIONS_ARCHIVE_DIR (it overrides the DATA_DIR default).
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'data', 'archive');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-'));
  setEnv();
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  const memoryDir = join(tmp, 'native', '.codex', 'memories');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), 'quartzledger: prefer explicit transactions.');
  mkdirSync(join(tmp, 'codex'), { recursive: true });

  // Session A: typed "deploy", then ran "kubectl apply". No error.
  writeFileSync(
    join(dir, 'a.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'deploy' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoA',
        timestamp: '2026-06-01T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl apply' } }],
        },
      }),
    ].join('\n'),
  );

  // Session B: multi-message session for hit→offset alignment - the unique term
  // sits in the third message (index 2), so a correct offset is load-bearing.
  writeFileSync(
    join(dir, 'b.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'investigate the flaky retry test' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'looking into it now' }] },
      }),
      j({
        type: 'assistant',
        cwd: '/repoB',
        timestamp: '2026-06-02T10:02:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'applied the mangowurzel fix to the retry logic' }],
        },
      }),
    ].join('\n'),
  );

  // Session C: files-filter fixture (phase 3) - edits a file no other session touches.
  writeFileSync(
    join(dir, 'c.jsonl'),
    [
      j({
        type: 'user',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'wire up billing' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: '/repoC',
        timestamp: '2026-06-03T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repoC/src/billing.ts' } }],
        },
      }),
    ].join('\n'),
  );

  // Sessions D and E: cwd is THIS repo, so get_context_primer resolves it and returns a
  // populated primer instead of a sentinel. Two of them, and E is trivia (2 messages, no
  // edits, no artifact) while D is substantive - so with `limit: 1` D fills the detail
  // tier and E is demoted into headlines, putting BOTH primer arrays under real data.
  //
  // D also carries 5 messages on purpose: getActivityDigest only builds sessionDetails
  // for rows with message_count > 3 (src/cache.ts:1081-1083), and the fattest of A/B/C
  // has 3 - so without D the digestSessionDetail schema is never exercised with an element.
  //
  // Nothing here may collide with the A/B/C assertions above: no 'kubectl', no 'flaky',
  // no 'mangowurzel', no 'src/billing.ts', and no errored tool results.
  writeFileSync(
    join(dir, 'd.jsonl'),
    [
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-04T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'bound the unbounded payload arrays' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:01:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${REPO_ROOT}/src/cap-audit.ts` } }],
        },
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:02:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${REPO_ROOT}/src/primer-cap.ts` } }],
        },
      }),
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-04T10:03:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'now measure the serialized size' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-04T10:04:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the capped payload is a fifth of the size' }] },
      }),
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'e.jsonl'),
    [
      j({
        type: 'user',
        cwd: REPO_ROOT,
        gitBranch: 'phase-1-payload-diet',
        timestamp: '2026-06-05T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'you around?' }] },
        promptSource: 'typed',
      }),
      j({
        type: 'assistant',
        cwd: REPO_ROOT,
        timestamp: '2026-06-05T10:01:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'yes' }] },
      }),
    ].join('\n'),
  );

  cache = await import('@pacifico/core/cache');
  cache.closeDb(); // drop any connection a prior test file opened on the shared module
  await cache.refreshIndex();

  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  rmSync(tmp, { recursive: true, force: true });
  if (originalNativeHome === undefined) delete process.env.SESSIONS_NATIVE_HOME;
  else process.env.SESSIONS_NATIVE_HOME = originalNativeHome;
});

test('search_sessions handler returns metadata + resumeCommand', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' });
  // { results, count } envelope: structuredContent must be a JSON object, not an array.
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.count).toBe(parsed.results.length);
  expect(parsed.results[0].commands).toContain('kubectl apply');
  expect(parsed.results[0].resumeCommand).toContain('claude --resume');
});

test('search_sessions handler honors the errored filter', async () => {
  const res = await mcp.runSearchSessions({ errored: true });
  expect(res.content[0]!.text).toContain('No sessions found'); // session A did not error
});

// --- message-granularity (schema v7) tests - additive ---

test('alignment: messageHits[0].index feeds get_session_messages(offset) to the matched text', async () => {
  const res = await mcp.runSearchSessions({ query: 'mangowurzel' });
  const parsed = JSON.parse(res.content[0]!.text);
  const hit = parsed.results[0].messageHits[0];
  expect(hit.index).toBe(2);
  expect(hit.role).toBe('assistant');

  const page = await mcp.runGetSessionMessages({ filePath: parsed.results[0].filePath, offset: hit.index, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.returned).toBe(1);
  expect(paged.messages[0].text).toContain('mangowurzel');
});

test('search_sessions: a metadata-only match carries empty messageHits', async () => {
  const res = await mcp.runSearchSessions({ query: 'kubectl' }); // lives only in commands
  const parsed = JSON.parse(res.content[0]!.text);
  const a = parsed.results.find((r: { sessionId: string }) => r.sessionId === 'a');
  expect(a.messageHits).toEqual([]);
});

// --- files filter (phase 3) tests - additive ---

test('search_sessions: files param reaches SearchOptions; result shape unchanged', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/billing.ts'] });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.results.map((r: { sessionId: string }) => r.sessionId)).toEqual(['c']); // a and b excluded
  expect(parsed.results[0].files).toContain('/repoC/src/billing.ts');
  expect(parsed.results[0].resumeCommand).toContain('claude --resume'); // shape unchanged
});

test('search_sessions: a non-matching files filter returns no sessions', async () => {
  const res = await mcp.runSearchSessions({ files: ['src/does-not-exist.ts'] });
  expect(res.content[0]!.text).toContain('No sessions found');
});

// --- get_session_digest (phase 2) tests - additive ---

test('get_session_digest returns exchange shape within budget', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'claude', 'proj', 'b.jsonl') });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.messageCount).toBe(3);
  expect(digest.exchangeCount).toBe(1);
  expect(digest.elided).toBe(0);
  expect(digest.exchanges).toHaveLength(1);
  expect(digest.exchanges[0].index).toBe(0);
  expect(digest.exchanges[0].user).toContain('investigate the flaky retry test');
  expect(digest.exchanges[0].assistant).toContain('mangowurzel'); // last assistant wins
  expect(JSON.stringify(digest).length).toBeLessThanOrEqual(8000);
});

test('get_session_digest flags unreadable files with isError', async () => {
  const res = await mcp.runGetSessionDigest({ filePath: join(tmp, 'nope', 'missing.jsonl') });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Could not read session');
});

test('get_session_digest returns empty exchanges for sessions with no genuine turns', async () => {
  // Standalone fixture outside the scanned dirs - the digest reads files directly.
  const file = join(tmp, 'hook-only.jsonl');
  writeFileSync(
    file,
    [
      j({
        type: 'user',
        timestamp: '2026-06-03T10:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'injected hook context' }] },
        promptSource: null,
      }),
    ].join('\n'),
  );
  const res = await mcp.runGetSessionDigest({ filePath: file });
  expect(res.isError).toBeUndefined();
  const digest = JSON.parse(res.content[0]!.text);
  expect(digest.exchanges).toEqual([]);
  expect(digest.messageCount).toBe(1);
});

// --- grep_sessions - additive ---

test('grep_sessions: exhaustive hit carries msgIndex that feeds get_session_messages', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'flaky' });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.totalHits).toBe(1);
  expect(parsed.totalSessions).toBe(1);
  const hit = parsed.hits[0];
  expect(hit.sessionId).toBe('b');
  expect(hit.role).toBe('user');
  expect(hit.resumeCommand).toContain('claude --resume');

  const page = await mcp.runGetSessionMessages({ filePath: hit.filePath, offset: hit.msgIndex, limit: 1 });
  const paged = JSON.parse(page.content[0]!.text);
  expect(paged.messages[0].text).toContain('flaky');
});

test('grep_sessions: regex mode matches an assistant turn', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'mango\\w+', regex: true });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.hits[0].role).toBe('assistant');
  expect(parsed.hits[0].msgIndex).toBe(2);
});

test('grep_sessions: no match returns a friendly message', async () => {
  const res = await mcp.runGrepSessions({ pattern: 'nonexistent-term-xyz' });
  expect(res.content[0]!.text).toContain('No matching messages found');
});

test('grep_sessions: an invalid regex surfaces isError', async () => {
  const res = await mcp.runGrepSessions({ pattern: '(unclosed', regex: true });
  expect(res.isError).toBe(true);
  expect(res.content[0]!.text).toContain('Invalid regex');
});

// --- get_session_messages include_tools - additive ---

test('get_session_messages include_tools renders the turn tool calls', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1, includeTools: true });
  const parsed = JSON.parse(res.content[0]!.text);
  // Session C's Edit is a pure-tool-use turn folded onto the user turn (index 0).
  expect(parsed.messages[0].tools).toContain('Edit(/repoC/src/billing.ts)');
});

test('get_session_messages omits tools by default (back-compat shape)', async () => {
  const file = join(tmp, 'claude', 'proj', 'c.jsonl');
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 1 });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.messages[0].tools).toBeUndefined();
});

test('server exits when the client closes stdin instead of lingering as an orphan', async () => {
  const proc = Bun.spawn(
    [process.execPath, 'run', join(import.meta.dir, '..', '..', '..', 'apps', 'cli', 'src', 'index.ts'), '--mcp'],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  proc.stdin.write(
    `${j({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })}\n`,
  );
  await proc.stdin.flush();
  // Wait for the initialize response so the transport is fully wired before we hang up.
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  proc.stdin.end(); // simulate the parent client dying
  const result = await Promise.race([proc.exited, Bun.sleep(5000).then(() => 'orphaned' as const)]);
  if (result === 'orphaned') proc.kill();
  expect(result).toBe(0);
}, 15000);

// --- protocol surface (phase 1) tests - additive ---
//
// Everything below goes through tools/list and tools/call over the SDK's in-memory
// transport, because that is the ONLY path that runs the SDK's output validation. The
// run* seams asserted above bypass it, so a tool whose structuredContent does not match
// its declared outputSchema would ship green without these.
//
// Mind what a failure looks like here: the SDK does not reject. McpServer catches its own
// McpError and returns an ordinary result with isError:true, so "the call did not throw"
// is a vacuous assertion that stays green even when every tool is broken. Asserting
// isError is falsy AND that the declared schema parses structuredContent is the real test.

async function connect(): Promise<Client> {
  const server = mcp.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sessions-test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const TOOL_NAMES = ['get_context', 'native_documents', 'read_session', 'search_sessions'];

test('MCP advertises exactly four tools, their object schemas, and no prompts', async () => {
  const client = await connect();
  try {
    expect(client.getServerVersion()?.version).toBe(pkgVersion);
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
      expect(tool.description!.length).toBeGreaterThan(80);
    }
  } finally {
    await client.close();
  }
});

test('every merged mode returns a populated schema-conforming response over MCP', async () => {
  const client = await connect();
  const filePath = join(tmp, 'claude', 'proj', 'b.jsonl');
  const cases = [
    { name: 'search_sessions', args: { query: 'mangowurzel' }, schema: SearchOutput },
    { name: 'search_sessions', args: { mode: 'literal', query: 'mangowurzel' }, schema: SearchOutput },
    { name: 'search_sessions', args: { mode: 'regex', query: 'mangow.rzel' }, schema: SearchOutput },
    { name: 'read_session', args: { filePath }, schema: ReadSessionOutput },
    { name: 'read_session', args: { filePath, format: 'messages', includeTools: true }, schema: ReadSessionOutput },
    { name: 'get_context', args: { cwd: REPO_ROOT, limit: 1 }, schema: ContextOutput },
    {
      name: 'get_context',
      args: { mode: 'activity', startDate: '2026-06-01', endDate: '2026-06-30', detail: 'highlights' },
      schema: ContextOutput,
    },
  ];
  try {
    const outputs = [];
    for (const entry of cases) {
      const result = await client.callTool({ name: entry.name, arguments: entry.args });
      expect(result.isError, `${entry.name}: ${firstText(result)}`).not.toBe(true);
      outputs.push(entry.schema.parse(result.structuredContent));
    }
    expect(outputs.map((output) => output.result.mode)).toEqual([
      'ranked',
      'literal',
      'regex',
      'digest',
      'messages',
      'project',
      'activity',
    ]);
    expect(SearchOutput.parse(outputs[0]).result.data).toHaveProperty('count');
    const literal = SearchOutput.parse(outputs[1]).result;
    expect(literal.mode).toBe('literal');
    if (literal.mode === 'literal') expect(literal.data.totalHits).toBeGreaterThan(0);
    const digest = ReadSessionOutput.parse(outputs[3]).result;
    if (digest.mode === 'digest') expect(digest.data.exchanges.length).toBeGreaterThan(0);
    const messages = ReadSessionOutput.parse(outputs[4]).result;
    if (messages.mode === 'messages') expect(messages.data.messages.length).toBeGreaterThan(0);
    const project = ContextOutput.parse(outputs[5]).result;
    if (project.mode === 'project') {
      expect(project.data.recent).toHaveLength(1);
      expect(project.data.headlines.length).toBeGreaterThan(0);
    }
    const activity = ContextOutput.parse(outputs[6]).result;
    if (activity.mode === 'activity') expect(activity.data.totalSessions).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test('ranked and pattern hits still lead to the exact message through read_session', async () => {
  const client = await connect();
  try {
    for (const mode of ['ranked', 'literal', 'regex']) {
      const response = await client.callTool({
        name: 'search_sessions',
        arguments: { mode, query: 'mangowurzel', limit: 1 },
      });
      const found = SearchOutput.parse(response.structuredContent).result;
      const hit =
        found.mode === 'ranked'
          ? { filePath: found.data.results[0]!.filePath, index: found.data.results[0]!.messageHits![0]!.index }
          : { filePath: found.data.hits[0]!.filePath, index: found.data.hits[0]!.msgIndex };
      const responseRead = await client.callTool({
        name: 'read_session',
        arguments: { filePath: hit.filePath, format: 'messages', offset: hit.index, limit: 1 },
      });
      expect(responseRead.isError).not.toBe(true);
      const result = ReadSessionOutput.parse(responseRead.structuredContent).result;
      if (result.mode === 'messages') {
        expect(result.data.messages).toHaveLength(1);
        expect(JSON.stringify(result.data.messages)).toContain('mangowurzel');
      }
    }
  } finally {
    await client.close();
  }
});

test('merged modes reject invalid ranges, unsafe page sizes, and irrelevant parameters', async () => {
  const client = await connect();
  const filePath = join(tmp, 'claude', 'proj', 'b.jsonl');
  const cases = [
    { name: 'search_sessions', arguments: { query: 'x', limit: -1 } },
    { name: 'search_sessions', arguments: { query: 'x', limit: 51 } },
    { name: 'search_sessions', arguments: { mode: 'literal', query: 'x', limit: 201 } },
    { name: 'search_sessions', arguments: { mode: 'literal' } },
    { name: 'search_sessions', arguments: { mode: 'regex', query: '[' } },
    { name: 'search_sessions', arguments: { query: 'x', after: '2026-07-01', before: '2026-06-01' } },
    { name: 'search_sessions', arguments: { query: 'x', after: '2026-02-30' } },
    { name: 'search_sessions', arguments: { query: 'x', role: 'user' } },
    { name: 'search_sessions', arguments: { mode: 'literal', query: 'x', files: ['file.ts'] } },
    { name: 'read_session', arguments: { filePath, offset: 1 } },
    { name: 'read_session', arguments: { filePath, format: 'messages', limit: 101 } },
    { name: 'read_session', arguments: { filePath, format: 'messages', offset: 0.5 } },
    { name: 'get_context', arguments: { mode: 'activity' } },
    { name: 'get_context', arguments: { mode: 'activity', startDate: '2026-07-01', endDate: '2026-06-01' } },
    { name: 'get_context', arguments: { limit: 26 } },
    { name: 'get_context', arguments: { startDate: '2026-06-01' } },
  ];
  try {
    for (const entry of cases) expect((await client.callTool(entry)).isError, JSON.stringify(entry)).toBe(true);
    for (const name of [
      'grep_sessions',
      'get_session_messages',
      'get_session_digest',
      'get_activity_digest',
      'get_context_primer',
      'get_session_metrics',
      'get_memory',
      'review_memory',
      'get_memory_sources',
      'review_agent_memories',
      'get_memory_recurrence',
      'why_did_this_change',
    ]) {
      expect((await client.callTool({ name, arguments: {} })).isError, name).toBe(true);
    }
  } finally {
    await client.close();
  }
});

test('empty results are valid results and ranked date filters apply before limits', async () => {
  const client = await connect();
  try {
    for (const mode of ['ranked', 'literal', 'regex']) {
      const response = await client.callTool({
        name: 'search_sessions',
        arguments: { mode, query: 'mangowurzel', after: '2099-01-01' },
      });
      expect(response.isError).not.toBe(true);
      const result = SearchOutput.parse(response.structuredContent).result;
      if (result.mode === 'ranked') expect(result.data.results).toEqual([]);
      else expect(result.data.totalHits).toBe(0);
    }
    const dated = await client.callTool({
      name: 'search_sessions',
      arguments: { after: '2026-06-02', before: '2026-06-02', limit: 1 },
    });
    expect(dated.isError).not.toBe(true);
    const datedResult = SearchOutput.parse(dated.structuredContent).result;
    expect(datedResult.mode).toBe('ranked');
    if (datedResult.mode === 'ranked') {
      expect(datedResult.data.results).toHaveLength(1);
      expect(datedResult.data.results[0]!.filePath).toBe(join(tmp, 'claude', 'proj', 'b.jsonl'));
    }
    const response = await client.callTool({ name: 'get_context', arguments: { cwd: join(tmp, 'no-repository') } });
    const project = ContextOutput.parse(response.structuredContent).result;
    if (project.mode === 'project') expect(project.data.isEmpty).toBe(true);
    const missing = await client.callTool({
      name: 'read_session',
      arguments: { filePath: join(tmp, 'missing.jsonl') },
    });
    expect(missing.isError).toBe(true);
  } finally {
    await client.close();
  }
});

test('project context neither creates nor reads a legacy memory database', async () => {
  const client = await connect();
  const legacy = join(tmp, 'data', 'memory.db');
  try {
    const first = await client.callTool({ name: 'get_context', arguments: { cwd: REPO_ROOT } });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).not.toHaveProperty('result.data.memory');
    expect(existsSync(legacy)).toBe(false);
    mkdirSync(join(tmp, 'data'), { recursive: true });
    writeFileSync(legacy, 'legacy database sentinel');
    const second = await client.callTool({ name: 'get_context', arguments: { cwd: REPO_ROOT } });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(readFileSync(legacy, 'utf8')).toBe('legacy database sentinel');
  } finally {
    await client.close();
    rmSync(legacy, { force: true });
  }
});

test('native_documents searches and reads original memory through MCP', async () => {
  const client = await connect();
  try {
    const search = await client.callTool({ name: 'native_documents', arguments: { query: 'quartzledger' } });
    expect(search.isError).toBeUndefined();
    const result = JSON.parse(firstText(search));
    expect(result.mode).toBe('search');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].harness).toBe('codex');
    expect(result.results[0].kind).toBe('memory');
    const read = await client.callTool({
      name: 'native_documents',
      arguments: { mode: 'read', id: result.results[0].id, limit: 12 },
    });
    expect(read.isError).toBeUndefined();
    const document = JSON.parse(firstText(read)).document;
    expect(document.content).toBe('quartzledger');
    expect(document.truncated).toBe(true);
    expect(document.path).toBe(join(tmp, 'native', '.codex', 'memories', 'MEMORY.md'));
    expect(readFileSync(document.path, 'utf8')).toBe('quartzledger: prefer explicit transactions.');
  } finally {
    await client.close();
  }
});

test('events mode reconstructs tool records through MCP without changing message offsets', async () => {
  const client = await connect();
  const path = join(tmp, 'event-pages.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'question' } }),
    JSON.stringify({ type: 'message', message: { role: 'tool', content: 'z'.repeat(42_000) } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'answer' } }),
  ];
  writeFileSync(path, lines.join('\n'));
  try {
    const reconstructed = ['', '', ''];
    let next: { offset: number; characterOffset: number } | null = { offset: 0, characterOffset: 0 };
    let pages = 0;
    while (next) {
      const response = await client.callTool({
        name: 'read_session',
        arguments: { filePath: path, format: 'events', ...next },
      });
      expect(response.isError).not.toBe(true);
      const result = ReadSessionOutput.parse(response.structuredContent).result;
      if (result.mode !== 'events') throw new Error('Expected events mode');
      for (const event of result.data.events) reconstructed[event.index] += event.text;
      next = result.data.next;
      expect(++pages).toBeLessThan(10);
    }
    expect(reconstructed).toEqual(lines);
    const messages = await client.callTool({
      name: 'read_session',
      arguments: { filePath: path, format: 'messages', offset: 1, limit: 1 },
    });
    expect(firstText(messages)).toContain('answer');
  } finally {
    await client.close();
    rmSync(path, { force: true });
  }
});

test('MCP event continuation rejects changed records and versions in other formats', async () => {
  const client = await connect();
  const path = join(tmp, 'versioned-events.jsonl');
  try {
    writeFileSync(path, '{"text":"first"}\n{"text":"later"}');
    const response = await client.callTool({
      name: 'read_session',
      arguments: { filePath: path, format: 'events', limit: 1 },
    });
    const result = ReadSessionOutput.parse(response.structuredContent).result;
    if (result.mode !== 'events' || !result.data.next) throw new Error('Expected event cursor');
    writeFileSync(path, '{"text":"other"}\n{"text":"later"}');
    const changed = await client.callTool({
      name: 'read_session',
      arguments: { filePath: path, format: 'events', ...result.data.next },
    });
    expect(changed.isError).toBe(true);
    expect(firstText(changed)).toContain('changed between pages');
    for (const format of ['digest', 'messages']) {
      const invalid = await client.callTool({
        name: 'read_session',
        arguments: { filePath: path, format, version: result.data.version },
      });
      expect(invalid.isError).toBe(true);
      expect(firstText(invalid)).toContain('version requires events format');
    }
    const restarted = await client.callTool({
      name: 'read_session',
      arguments: { filePath: path, format: 'events' },
    });
    expect(restarted.isError).not.toBe(true);
    expect(firstText(restarted)).toContain('other');
  } finally {
    await client.close();
    rmSync(path, { force: true });
  }
});
