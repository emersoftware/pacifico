import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('CLI and opt-in MCP share a persistent session host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-session-cli-'));
  const fixture = join(root, 'fixture.ts');
  writeFileSync(
    fixture,
    `
    import { createInterface } from 'node:readline';
    let previous = '';
    const id = Bun.argv[Bun.argv.indexOf('--session-id') + 1];
    const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      const value = JSON.parse(line);
      if (value.method === 'initialize') send({ id: value.id, result: {} });
      if (value.method === 'thread/start') send({ id: value.id, result: { thread: { id: 'codex-fixture' } } });
      if (value.method === 'turn/start') {
        send({ id: value.id, result: { turn: { id: 'turn' } } });
        send({ method: 'item/completed', params: { threadId: 'codex-fixture', turnId: 'turn', item: { type: 'agentMessage', text: previous || value.params.input[0].text } } });
        previous = value.params.input[0].text;
        send({ method: 'turn/completed', params: { threadId: 'codex-fixture', turn: { id: 'turn', status: 'completed' } } });
      }
      if (value.type === 'user') {
        send({ type: 'result', subtype: 'success', session_id: id, result: previous || value.message.content });
        previous = value.message.content;
      }
    });
  `,
  );
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  for (const harness of ['claude', 'codex']) {
    const path = join(root, harness);
    writeFileSync(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`);
    chmodSync(path, 0o700);
  }
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  Object.assign(env, {
    PATH: `${root}:${env.PATH}`,
    SESSIONS_HOME: root,
    SESSIONS_DATA_DIR: join(root, 'data'),
    SESSIONS_CACHE_DIR: join(root, 'cache'),
  });
  const program = process.env.PACIFICO_TEST_CLI_BINARY
    ? [process.env.PACIFICO_TEST_CLI_BINARY]
    : [process.execPath, resolve(import.meta.dir, '../../../../apps/cli/src/index.ts')];
  async function cli(...args: string[]) {
    const child = Bun.spawn([...program, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout);
  }
  const client = new Client({ name: 'session-test', version: '1' });
  try {
    // Simultaneous clients must converge on one host, not replace its socket.
    const lists = await Promise.all([cli('sessions', '--json'), cli('sessions', '--json')]);
    expect(lists).toEqual([[], []]);
    for (const harness of ['claude', 'codex']) {
      const first = await cli('start', harness, 'Remember coral', '--cwd', root, '--wait', '--json');
      expect(first.status).toBe('completed');
      const second = await cli('send', first.session, 'What was it?', '--wait', '--json');
      expect(second.session).toBe(first.session);
      expect(second.text).toBe('Remember coral');
      expect(second.request).not.toBe(first.request);
      await cli('sessions', 'close', first.session, '--json');
      await expect(cli('send', first.session, 'Do not create a replacement', '--wait', '--json')).rejects.toThrow(
        harness === 'claude' ? 'not connected' : 'ENOENT',
      );
    }
    await client.connect(
      new StdioClientTransport({
        command: program[0]!,
        args: [...program.slice(1), '--mcp', '--session-control'],
        env,
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('start_session');
    expect(tools.tools.find((tool) => tool.name === 'send_to_session')?.annotations?.readOnlyHint).toBe(false);
    const listed = await client.callTool({ name: 'list_sessions', arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.parse((listed.content as { text: string }[])[0]!.text)).toHaveLength(2);
  } finally {
    await client.close();
    try {
      await cli('sessions', 'stop', '--json');
    } finally {
      await Bun.sleep(250);
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20000);
