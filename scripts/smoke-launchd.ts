import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderLaunchAgent, DAEMON_LABEL } from '@pacifico/agents/daemon';
import { z } from 'zod';

// An ephemeral launchd job with synthetic sources and a unique label. It never
// loads the user's Pacifico job or installs anything in Library/LaunchAgents.
if (process.platform !== 'darwin' || !process.getuid) throw new Error('This smoke test requires a macOS GUI session.');
const directory = mkdtempSync(join(tmpdir(), 'pacifico-launchd-'));
const label = `${DAEMON_LABEL}.test-${randomUUID()}`;
const target = `gui/${process.getuid()}/${label}`;
const data = join(directory, 'data');
const source = join(directory, 'claude', 'project');
const stateFile = join(data, 'daemon-state.json');
const stateSchema = z.object({ ok: z.boolean(), completedAt: z.string(), total: z.number().optional() });
const plistPath = join(directory, `${label}.plist`);
let registered = false;

function ctl(...args: string[]): void {
  const result = Bun.spawnSync(['/bin/launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
}

async function waitForRun(after: string): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      const state = stateSchema.parse(JSON.parse(readFileSync(stateFile, 'utf8')));
      if (state.completedAt !== after) {
        assert.equal(state.ok, true);
        assert.equal(state.total, 1);
        return state.completedAt;
      }
    }
    await Bun.sleep(100);
  }
  const details = Bun.spawnSync(['/bin/launchctl', 'print', target]);
  throw new Error('launchd did not finish the fixture import within 45s\n' + new TextDecoder().decode(details.stdout));
}

try {
  mkdirSync(source, { recursive: true });
  const native = join(source, 'launchd-fixture.jsonl');
  const row = {
    type: 'user',
    cwd: directory,
    timestamp: '2026-09-05T10:00:00Z',
    message: { role: 'user', content: 'launchd fixture archive' },
  };
  writeFileSync(native, JSON.stringify(row) + '\n');
  const env = {
    PATH: '/usr/bin:/bin',
    SESSIONS_HOME: directory,
    SESSIONS_DATA_DIR: data,
    SESSIONS_ARCHIVE_DIR: join(data, 'archive'),
    SESSIONS_CACHE_DIR: join(directory, 'cache'),
    SESSIONS_CLAUDE_DIR: join(directory, 'claude'),
    SESSIONS_CODEX_DIR: join(directory, 'absent-codex'),
    SESSIONS_PI_DIR: join(directory, 'absent-pi'),
    SESSIONS_OPENCODE_DB: join(directory, 'absent-opencode.db'),
  };
  writeFileSync(
    plistPath,
    renderLaunchAgent([resolve('dist/pacifico'), 'daemon', 'run'], env).replaceAll(DAEMON_LABEL, label),
    { mode: 0o600 },
  );
  const lint = Bun.spawnSync(['/usr/bin/plutil', '-lint', plistPath]);
  assert.equal(lint.exitCode, 0);
  ctl('bootstrap', target.slice(0, target.lastIndexOf('/')), plistPath);
  registered = true;
  const first = await waitForRun('');
  writeFileSync(
    native,
    JSON.stringify({ ...row, message: { role: 'user', content: 'changed fixture content' } }) + '\n',
  );
  ctl('kickstart', '-k', target);
  await waitForRun(first);
  assert.ok(readFileSync(join(data, 'archive', 'manifest.json'), 'utf8').includes('launchd-fixture'));
  process.stdout.write(
    'launchd smoke: valid plist, bootstrap, first import, changed-source import and cleanup passed.\n',
  );
} finally {
  if (registered) ctl('bootout', target);
  rmSync(directory, { recursive: true, force: true });
}
