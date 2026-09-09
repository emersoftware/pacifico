import { randomBytes } from 'node:crypto';
const name = `pacifico-test-${process.pid}-${randomBytes(4).toString('hex')}`;
const password = randomBytes(16).toString('hex');
function docker(...args: string[]) {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
let created = false;
try {
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-p',
    '127.0.0.1::5432',
    'postgres:17-bookworm',
  );
  created = true;
  const address = docker('port', name, '5432');
  const deadline = Date.now() + 60_000;
  while (true) {
    const ready = Bun.spawnSync(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if (ready.exitCode === 0) break;
    if (Date.now() > deadline) throw new Error('PostgreSQL startup timed out');
    await Bun.sleep(250);
  }
  const test = Bun.spawn([process.execPath, 'test', 'apps/server/src/server.test.ts'], {
    env: { ...process.env, PACIFICO_TEST_DATABASE_URL: `postgres://postgres:${password}@${address}/postgres` },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await test.exited;
  if (code !== 0) throw new Error(`Server tests failed (${code})`);
} finally {
  if (created) docker('rm', '--force', name);
}
