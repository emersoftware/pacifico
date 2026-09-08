import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Database } from 'bun:sqlite';
import { version as pkgVersion } from '../../../package.json';
import { asJsonObject, asJsonString, type JsonObject, type JsonValue } from '@pacifico/core/extract-util';
import { buildRecord } from '@pacifico/core/memory/record';
import { closeMemoryDb, setState, upsertCandidates } from '@pacifico/core/memory/store';
import { SearchOutput, ReadSessionOutput, ContextOutput, ReviewMemoryOutput, GetMemoryOutput } from './mcp-schemas';

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

/** Parse a tool result's compact-JSON text block. Throws on non-objects. */
function payloadOf(res: { content: { text: string }[] }): JsonObject {
  const parsed = asJsonObject(JSON.parse(res.content[0]!.text));
  if (!parsed) throw new Error('tool payload is not a JSON object');
  return parsed;
}

// cache.ts resolves SESSIONS_* env lazily, but the module instance is shared across
// test files in one `bun test` run. So we (re)assert our env and reset the cached DB
// connection before each test - keeping this file hermetic regardless of which other
// cache-importing file (cache.search.test.ts, context.test.ts) ran first or interleaves.
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
  process.env.SESSIONS_PI_DIR = join(tmp, 'pi');
  process.env.SESSIONS_CODEX_DIR = join(tmp, 'codex');
  process.env.SESSIONS_OPENCODE_DB = join(tmp, 'opencode.db'); // absent → no OpenCode sessions leak in
  // Required now that tools/call reaches get_memory from this file: without it the memory
  // store would open (and create) the developer's real ~/.local/share/pacifico/memory.db.
  process.env.SESSIONS_DATA_DIR = join(tmp, 'data');
  // Shadow any leaked SESSIONS_ARCHIVE_DIR (it overrides the DATA_DIR default).
  process.env.SESSIONS_ARCHIVE_DIR = join(tmp, 'data', 'archive');
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-mcp-'));
  setEnv();
  // Seed this fixture's store rather than a cached connection from another file.
  closeMemoryDb();
  const dir = join(tmp, 'claude', 'proj');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(tmp, 'pi'), { recursive: true });
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

  // One approved memory scoped to /repoA. Without it get_memory's conformance call hits
  // the empty-store sentinel, and its populated projection (text / kind / scope) is never
  // validated through tools/call - the empty payload has the same shape either way.
  // Repo-scoped, not workflow-scoped, so it cannot leak into the empty-index block below
  // (which uses its own SESSIONS_DATA_DIR and a cwd of /nowhere).
  const memory = buildRecord({
    text: 'Always run bun run typecheck before opening a pull request',
    scope: { type: 'repo', key: '/repoA' },
    author: 'dev@example.com',
    sessions: ['/s/a.jsonl'],
    dates: ['2026-06-01'],
    distinctPhrasings: 1,
  });
  upsertCandidates([memory]);
  setState(memory.id, 'approved');
  closeMemoryDb();

  // Agent memory stores, so get_memory_sources and review_agent_memories have a
  // populated fixture. The paths derive from the same env the session fixtures use:
  // piHermesDir <- SESSIONS_PI_DIR, codexHome <- dirname(SESSIONS_CODEX_DIR),
  // claudeHome <- dirname(SESSIONS_CLAUDE_DIR) (src/memory/sources.ts).
  const hermesDir = join(tmp, 'pi-hermes-memory');
  mkdirSync(hermesDir, { recursive: true });
  const hermesDb = new Database(join(hermesDir, 'sessions.db'));
  hermesDb.run(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT, target TEXT NOT NULL, category TEXT, content TEXT NOT NULL,
    failure_reason TEXT, tool_state TEXT, corrected_to TEXT,
    created DATE NOT NULL, last_referenced DATE NOT NULL
  )`);
  hermesDb.run(
    "INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (NULL, 'memory', 'correction', 'Never rewrite the lockfile by hand, run the installer', '2026-08-01', '2026-08-05')",
  );
  hermesDb.close();
  mkdirSync(join(tmp, 'rules'), { recursive: true });
  writeFileSync(join(tmp, 'rules', 'default.rules'), 'prefix_rule(pattern=["gh", "run", "view"], decision="allow")\n');
  writeFileSync(join(tmp, 'CLAUDE.md'), '- A global instruction of sufficient length to be a fact.\n');

  mcp = await import('./mcp');
});

beforeEach(() => {
  setEnv();
  cache.closeDb(); // next query reopens against our getDbPath()
  closeMemoryDb();
});

afterAll(() => {
  cache.closeDb(); // release the handle before deleting the temp dir
  closeMemoryDb();
  rmSync(tmp, { recursive: true, force: true });
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

// --- pi fork surfaces (pi first-class phase 2) - additive ---

function writePiFixture(id: string, records: JsonObject[]): string {
  const dir = join(tmp, 'pi', 'proj');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => j(r)).join('\n'));
  return file;
}

// Pi fixture shapes mirror src/parser.test.ts: id/parentId on every line, the header
// is the root, the header-adjacent model_change has parentId: null.
const piHeader = (extra: JsonObject = {}) => ({
  type: 'session',
  id: 's1',
  timestamp: '2026-08-04T17:00:00.000Z',
  cwd: '/repoPi',
  ...extra,
});
const piModelChange = { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-08-04T17:00:01.000Z' };
const piUser = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:01:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const piAssistant = (id: string, parentId: string, text: string) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-08-04T17:02:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

// The canonical one-fork shape: /tree hops back to u1 (abandoning u2/a2), then back
// to a1 to resume the live conversation. 6 extracted messages, 1 fork marker.
function branchedPiRecords(): JsonObject[] {
  return [
    piHeader(),
    piModelChange,
    piUser('u1', 'm1', 'first question'),
    piAssistant('a1', 'u1', 'first answer'),
    piUser('u2', 'u1', 'hello world'),
    piAssistant('a2', 'u2', 'abandoned answer'),
    piUser('u3', 'a1', 'the real follow-up'),
    piAssistant('a3', 'u3', 'the live answer'),
  ];
}

const PI_PARENT = '/Users/dev/.pi/agent/sessions/--repoPi--/parent-file.jsonl';

test('search_sessions: pi results carry branches and a basename-only forkedFrom', async () => {
  writePiFixture('pibranch', branchedPiRecords());
  writePiFixture('pifork', [piHeader({ parentSession: PI_PARENT }), piModelChange, piUser('u1', 'm1', 'continued')]);
  await cache.refreshIndex();
  const res = await mcp.runSearchSessions({ tool: 'pi' });
  const parsed = payloadOf(res);
  const results = parsed.results;
  const byId = new Map<string, JsonObject>();
  if (Array.isArray(results)) {
    for (const r of results) {
      const row = asJsonObject(r);
      const id = row ? asJsonString(row.sessionId) : undefined;
      if (row && id !== undefined) byId.set(id, row);
    }
  }
  expect(byId.get('pibranch')).toMatchObject({ branches: 1, forkedFrom: '' });
  // Basename only - agents don't need (and shouldn't act on) the absolute parent path.
  expect(byId.get('pifork')).toMatchObject({ branches: 0, forkedFrom: 'parent-file.jsonl' });
});

test("get_session_messages: the fork marker is a field on the branch's first message; total unchanged", async () => {
  const file = writePiFixture('pimarkers', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 20 });
  const parsed = JSON.parse(res.content[0]!.text);
  // The core invariant: a marker is a FIELD, never a synthetic message row - `total`
  // must equal the unbranched message count, or every search-hit offset drifts.
  expect(parsed.total).toBe(6);
  const msgs = payloadOf(res).messages;
  if (!Array.isArray(msgs)) throw new Error('messages missing');
  expect(msgs.map((m) => asJsonObject(m)?.branch ?? '')).toEqual(['', '', 'abandoned', 'abandoned', '', '']);
  expect(msgs.filter((m) => asJsonObject(m)?.fork)).toHaveLength(1);
  // The marker hangs on the branch's first message (index 2) and names the active
  // message it forked from (index 0, from u1).
  const markerMsg = asJsonObject(msgs[2]);
  const fork = asJsonObject(markerMsg?.fork);
  expect(fork).toMatchObject({ fromIndex: 0, abandonedCount: 2, firstUserText: 'hello world' });
  expect(fork?.marker).toBe('⑂ forked from msg #0 - abandoned branch, 2 messages: "hello world"');
  // Active messages carry no branch/fork keys at all (zero token cost).
  const firstMsg = asJsonObject(msgs[0]);
  if (!firstMsg) throw new Error('message 0 missing');
  expect('branch' in firstMsg).toBe(false);
  expect('fork' in firstMsg).toBe(false);
});

test('get_session_messages: markers and branch fields appear with includeTools on too', async () => {
  const file = writePiFixture('pimarkers2', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 0, limit: 20, includeTools: true });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.total).toBe(6);
  expect(parsed.messages[2].branch).toBe('abandoned');
  expect(parsed.messages[2].fork.marker).toContain('⑂ forked from msg #0');
});

test('get_session_messages: an offset landing exactly on a fork marker returns the marked message first', async () => {
  const file = writePiFixture('pimarkers3', branchedPiRecords());
  const res = await mcp.runGetSessionMessages({ filePath: file, offset: 2, limit: 1 });
  const parsed = JSON.parse(res.content[0]!.text);
  expect(parsed.returned).toBe(1);
  expect(parsed.messages[0].text).toBe('hello world');
  expect(parsed.messages[0].fork.marker).toContain('abandoned branch');
});

test('schema conformance: fork fields survive tools/call output validation (not zod-stripped)', async () => {
  const file = writePiFixture('pimarkers4', branchedPiRecords());
  writePiFixture('pifork2', [piHeader({ parentSession: PI_PARENT }), piModelChange, piUser('u1', 'm1', 'continued')]);
  await cache.refreshIndex();
  const client = await connect();

  const msgRes = await client.callTool({ name: 'read_session', arguments: { filePath: file, format: 'messages' } });
  expect(msgRes.isError).toBeFalsy();
  const messageResult = ReadSessionOutput.parse(msgRes.structuredContent).result;
  if (messageResult.mode !== 'messages') throw new Error('Expected messages');
  const msgs = messageResult.data;
  expect(msgs.messages[2]!.branch).toBe('abandoned');
  expect(msgs.messages[2]!.fork?.marker).toContain('abandoned branch');

  const searchRes = await client.callTool({ name: 'search_sessions', arguments: { tool: 'pi' } });
  expect(searchRes.isError).toBeFalsy();
  const searchResult = SearchOutput.parse(searchRes.structuredContent).result;
  if (searchResult.mode !== 'ranked') throw new Error('Expected ranked search');
  const search = searchResult.data;
  const forked = search.results.find((r) => r.sessionId === 'pifork2');
  expect(forked?.forkedFrom).toBe('parent-file.jsonl');
  expect(search.results.find((r) => r.sessionId === 'pimarkers4')?.branches).toBe(1);
  await client.close();
});

// --- stdio lifecycle ---

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

const TOOL_NAMES = ['get_context', 'get_memory', 'read_session', 'review_memory', 'search_sessions'];

test('MCP advertises exactly five tools, their object schemas, and no prompts', async () => {
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
    { name: 'get_memory', args: { cwd: '/repoA' }, schema: GetMemoryOutput },
    { name: 'review_memory', args: { cwd: '/repoA' }, schema: ReviewMemoryOutput },
    { name: 'review_memory', args: { mode: 'entries', cwd: '/repoA' }, schema: ReviewMemoryOutput },
    { name: 'review_memory', args: { mode: 'recurrence', all: true }, schema: ReviewMemoryOutput },
  ];
  try {
    const outputs = [];
    for (const entry of cases) {
      const result = await client.callTool({ name: entry.name, arguments: entry.args });
      expect(result.isError, `${entry.name}: ${firstText(result)}`).not.toBe(true);
      outputs.push(entry.schema.parse(result.structuredContent));
    }
    expect(outputs.map((output) => ('result' in output ? output.result.mode : 'memory'))).toEqual([
      'ranked',
      'literal',
      'regex',
      'digest',
      'messages',
      'project',
      'activity',
      'memory',
      'sources',
      'entries',
      'recurrence',
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
    expect(GetMemoryOutput.parse(outputs[7]).results.length).toBeGreaterThan(0);
    const sources = ReviewMemoryOutput.parse(outputs[8]).result;
    if (sources.mode === 'sources') expect(sources.data.sources.length).toBeGreaterThan(0);
    const entries = ReviewMemoryOutput.parse(outputs[9]).result;
    if (entries.mode === 'entries') expect(entries.data.memories.length).toBeGreaterThan(0);
    const memoryAfter = await client.callTool({ name: 'get_memory', arguments: { cwd: '/repoA' } });
    expect(GetMemoryOutput.parse(memoryAfter.structuredContent)).toEqual(GetMemoryOutput.parse(outputs[7]));
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
    { name: 'review_memory', arguments: { mode: 'sources', topic: 'build' } },
    { name: 'review_memory', arguments: { mode: 'entries', all: true } },
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
    const memory = await client.callTool({
      name: 'get_memory',
      arguments: { cwd: '/nowhere', topic: 'unmatchedquartz' },
    });
    expect(GetMemoryOutput.parse(memory.structuredContent).results).toEqual([]);
    const missing = await client.callTool({
      name: 'read_session',
      arguments: { filePath: join(tmp, 'missing.jsonl') },
    });
    expect(missing.isError).toBe(true);
  } finally {
    await client.close();
  }
});
