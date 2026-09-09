import { randomBytes } from 'node:crypto';
import { remoteRequest } from '../packages/core/src/sync/client';
import { identitySchema, inventorySchema, remoteId, type Snapshot } from '../packages/core/src/sync/protocol';
import { callRemoteTool } from '../packages/agents/src/remote';

const project = `pacifico-smoke-${process.pid}-${randomBytes(3).toString('hex')}`;
const environment = {
  ...process.env,
  POSTGRES_PASSWORD: randomBytes(16).toString('hex'),
  BIND_ADDRESS: '127.0.0.1',
  SERVER_PORT: '0',
  PUBLIC_URL: 'http://localhost:8787',
};
async function compose(...args: string[]) {
  const result = Bun.spawn(['docker', 'compose', '-p', project, '-f', 'apps/server/compose.yml', ...args], {
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, error] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error || `Compose failed (${code})`);
  return out.trim();
}
async function endpoint() {
  return `http://${await compose('port', 'server', '8787')}`;
}
async function ready(url: string) {
  const end = Date.now() + 60000;
  while (true) {
    try {
      if ((await fetch(url + '/health')).ok) return;
    } catch {}
    if (Date.now() > end) throw new Error('Server readiness timed out');
    await Bun.sleep(250);
  }
}
try {
  console.log('Building and starting an isolated Compose deployment.');
  await compose('up', '-d', '--build', '--wait', '--wait-timeout', '60');
  let url = await endpoint();
  await ready(url);
  const token = await compose('exec', '-T', 'server', 'pacifico-server', 'credential', 'fixture', 'sync', 'Mac');
  let config = {
    endpoint: url,
    token,
    allowHttp: false,
    identity: identitySchema.parse(await remoteRequest({ endpoint: url, token, allowHttp: false }, '/v1/me')),
  };
  const snapshot: Snapshot = {
    kind: 'session',
    harness: 'claude',
    sourcePath: '/fixture/transcript.jsonl',
    sessionId: 'docker',
    cwd: '/fixture',
    modifiedAt: '2026-09-09T12:00:00.000Z',
    content: JSON.stringify({
      type: 'user',
      timestamp: '2026-09-09T12:00:00Z',
      message: { role: 'user', content: 'volumequartz survives recreation' },
    }),
  };
  await remoteRequest(config, '/v1/snapshots', { snapshot, previousHash: null });
  console.log('Recreating containers while retaining the PostgreSQL volume.');
  await compose('down');
  await compose('up', '-d', '--wait', '--wait-timeout', '60');
  url = await endpoint();
  await ready(url);
  config = { ...config, endpoint: url };
  const inventory = inventorySchema.parse(await remoteRequest(config, '/v1/inventory'));
  if (inventory.length !== 1) throw new Error('Snapshot did not survive container recreation');
  const result = await callRemoteTool(config, 'read_session', {
    filePath: remoteId(config.identity.deviceId!, inventory[0]!.key),
    format: 'messages',
  });
  if (result.isError || !result.content[0]?.text.includes('volumequartz'))
    throw new Error('Archived transcript unavailable after restart');
  console.log('Docker smoke: credential, upload, persistent volume, container recreation and MCP read passed.');
} finally {
  await compose('down', '--volumes', '--remove-orphans');
}
