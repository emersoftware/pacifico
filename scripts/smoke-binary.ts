import { version } from '../package.json';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SearchOutput, ReadSessionOutput } from '@pacifico/agents/mcp-schemas';

// Exercise the shipped executable, including stdio framing and client config
// writes. Every source and destination is synthetic; no real agent CLI is invoked.
const dir = mkdtempSync(join(tmpdir(), 'pacifico-binary-'));
const binary = resolve('dist/pacifico');
const data = join(dir, 'data');
const claude = join(dir, 'sources', 'claude');
const codex = join(dir, 'sources', 'codex');
const env = {
  PATH: '/usr/bin:/bin',
  SESSIONS_HOME: dir,
  SESSIONS_DATA_DIR: data,
  SESSIONS_CACHE_DIR: join(dir, 'cache'),
  SESSIONS_CLAUDE_DIR: claude,
  SESSIONS_CODEX_DIR: codex,
  SESSIONS_OPENCODE_DB: join(dir, 'absent-opencode.db'),
};
const client = new Client({ name: 'pacifico-smoke', version: '1' });
let connected = false;
function run(...command: string[]): string {
  const result = Bun.spawnSync([binary, ...command], { env, stdin: 'ignore' });
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}
try {
  for (const path of [data, join(dir, '.codex'), join(claude, 'project'), codex]) mkdirSync(path, { recursive: true });
  const config = join(dir, '.codex/config.toml');
  const foreign = '[mcp_servers.sessions]\ncommand = "/original/sessions"\n\n[mcp_servers.other]\ncommand = "/other"\n';
  writeFileSync(config, foreign);
  const native = join(claude, 'project', 'pacifico-smoke.jsonl');
  const rows = [
    {
      type: 'user',
      sessionId: 'pacifico-smoke',
      cwd: dir,
      timestamp: '2026-09-01T10:00:00Z',
      message: { role: 'user', content: 'pacificoquartz archive decision' },
    },
    {
      type: 'assistant',
      sessionId: 'pacifico-smoke',
      cwd: dir,
      timestamp: '2026-09-01T10:01:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Use a durable transcript vault.' }] },
    },
  ];
  const contents = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(native, contents);
  assert.equal(run('--version').trim(), `pacifico ${version}`);
  const settings = join(dir, '.claude', 'settings.json');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'pacifico context --hook' },
              { type: 'command', command: 'echo keep-other-hook' },
            ],
          },
        ],
      },
    }),
  );
  const oldSkill = join(data, 'plugin', 'skills', 'recall');
  mkdirSync(oldSkill, { recursive: true });
  writeFileSync(join(oldSkill, 'SKILL.md'), 'retired skill');
  run('install');
  assert.ok(!readFileSync(settings, 'utf8').includes('pacifico context --hook'));
  assert.ok(readFileSync(settings, 'utf8').includes('echo keep-other-hook'));
  assert.ok(!existsSync(oldSkill));
  assert.ok(existsSync(join(data, 'plugin', 'skills', 'adr', 'SKILL.md')));
  assert.ok(existsSync(join(dir, '.agents', 'skills', 'adr', 'SKILL.md')));
  assert.ok(existsSync(join(data, 'plugin', 'skills', 'sync', 'SKILL.md')));
  assert.ok(existsSync(join(dir, '.agents', 'skills', 'sync', 'SKILL.md')));
  const installed = readFileSync(config, 'utf8');
  assert.ok(installed.includes('[mcp_servers.pacifico]'));
  assert.ok(installed.includes(binary));
  assert.ok(installed.includes(foreign.trim()));
  run('install');
  assert.equal(readFileSync(config, 'utf8'), installed);
  // A daemon and MCP caller can refresh simultaneously. Both processes must
  // complete and preserve the same archive; the lock is shared across them.
  const workers = [0, 1].map(() => Bun.spawn([binary, 'daemon', 'run'], { env, stdout: 'pipe', stderr: 'pipe' }));
  for (const worker of workers) {
    assert.equal(await worker.exited, 0, await new Response(worker.stderr).text());
  }
  assert.ok(readFileSync(join(data, 'daemon-state.json'), 'utf8').includes('"ok":true'));
  assert.equal(readFileSync(native, 'utf8'), contents);
  // Prove capture happened without a search: remove the native transcript, clear
  // the disposable index, and rebuild using only the archived copy.
  rmSync(native);
  run('--clear-cache');
  run('daemon', 'run');
  await client.connect(new StdioClientTransport({ command: binary, args: ['--mcp'], env }));
  connected = true;
  assert.equal(client.getServerVersion()?.name, 'pacifico');
  assert.equal(client.getServerCapabilities()?.prompts, undefined);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'get_context',
    'native_documents',
    'read_session',
    'search_sessions',
  ]);
  const found = await client.callTool({ name: 'search_sessions', arguments: { query: 'pacificoquartz' } });
  assert.ok(!found.isError);
  const searchResult = SearchOutput.parse(found.structuredContent).result;
  assert.equal(searchResult.mode, 'ranked');
  if (searchResult.mode !== 'ranked') throw new Error('Unexpected search mode');
  const search = searchResult.data;
  assert.equal(search.results.length, 1);
  const hit = search.results[0]!;
  const read = await client.callTool({
    name: 'read_session',
    arguments: { filePath: hit.filePath, format: 'messages', limit: 5 },
  });
  assert.ok(!read.isError);
  assert.ok(JSON.stringify(ReadSessionOutput.parse(read.structuredContent)).includes('durable transcript vault'));
  assert.ok(!existsSync(native));
  const context = await client.callTool({ name: 'get_context', arguments: { cwd: dir } });
  assert.ok(!context.isError);
  assert.ok(!JSON.stringify(context.structuredContent).includes('memory'));
  assert.ok(!existsSync(join(data, 'memory.db')));
  const numbered = JSON.parse(run('read', hit.filePath, '--json'));
  assert.equal(numbered.messages[0].index, 0);
  const decisionInput = join(dir, 'decision.json');
  writeFileSync(
    decisionInput,
    JSON.stringify({
      project: dir,
      title: 'Archive fixture',
      decision: 'Retain the source archive.',
      decidedAt: '2026-09-01',
      evidence: [{ filePath: hit.filePath, messageIndex: 0, quote: 'pacificoquartz archive decision' }],
    }),
  );
  const decision = JSON.parse(run('decisions', 'save', '--file', decisionInput));
  assert.equal(JSON.parse(run('decisions', 'list', '--project', dir))[0].id, decision.id);
  const savedContext = await client.callTool({
    name: 'get_context',
    arguments: { mode: 'decisions', cwd: dir, scope: 'local' },
  });
  assert.ok(!savedContext.isError);
  assert.ok(JSON.stringify(savedContext.structuredContent).includes(decision.id));
  assert.equal(JSON.parse(run('decisions', 'export', '--project', dir, '--out', join(dir, 'adr'))).files.length, 1);
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({ mcpServers: { fixture: { command: 'fixture-server', args: [] } } }),
  );
  const preview = JSON.parse(run('sync', '--from', 'claude', '--to', 'codex', '--kind', 'mcp'));
  assert.equal(preview.applied, false);
  assert.ok(!readFileSync(config, 'utf8').includes('fixture-server'));
  assert.equal(JSON.parse(run('sync', '--from', 'claude', '--to', 'codex', '--kind', 'mcp', '--apply')).applied, true);
  assert.ok(readFileSync(config, 'utf8').includes('fixture-server'));
  const usageInput = join(dir, 'usage.json');
  writeFileSync(
    usageInput,
    JSON.stringify({
      usageEventsDisplay: [
        {
          conversationId: 'usage-fixture',
          model: 'test',
          timestamp: 1577880000000,
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 },
        },
      ],
    }),
  );
  run('usage', 'import', '--harness', 'cursor', '--file', usageInput);
  const usage = JSON.parse(run('usage', '--cached', '--json'));
  assert.equal(usage.periods.all.tokens, 350);
  const retired = Bun.spawnSync([binary, 'memory', 'mine'], { env, stdin: 'ignore' });
  assert.equal(retired.exitCode, 1);
  assert.ok(new TextDecoder().decode(retired.stderr).includes('removed'));
  await client.close();
  connected = false;
  assert.ok(existsSync(join(data, 'archive')));
  const archiveBefore = run('vault');
  run('uninstall');
  assert.ok(!existsSync(join(data, 'memory.db')));
  assert.ok(existsSync(join(data, 'archive')));
  assert.ok(readFileSync(config, 'utf8').includes(foreign.trim()));
  assert.ok(!readFileSync(config, 'utf8').includes('[mcp_servers.pacifico]'));
  assert.equal(run('vault'), archiveBefore);
  process.stdout.write(
    'Binary smoke: retired hook/skill upgrade cleanup, no prompts, install twice, foreign config preservation, MCP handshake, 4 tools, search/read, native source unchanged, durable uninstall passed.\n',
  );
} finally {
  if (connected) await client.close();
  rmSync(dir, { recursive: true, force: true });
}
