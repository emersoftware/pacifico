import { expect, test } from 'bun:test';
import { renderLaunchAgent, DAEMON_INTERVAL_SECONDS } from './daemon';

test('launchd receives escaped argv, a bounded schedule, and only explicit configuration', () => {
  const plist = renderLaunchAgent(['/path with spaces/A&B/pacifico', 'daemon', 'run'], {
    PATH: '/usr/bin:/bin',
    SESSIONS_CLAUDE_DIR: './transcripts',
    SESSIONS_HOME: '/fixture/configured-home',
    ANTHROPIC_API_KEY: 'never-persist-this',
  });
  expect(plist).toContain('<string>/path with spaces/A&amp;B/pacifico</string>');
  expect(plist).toContain(`<key>StartInterval</key><integer>${DAEMON_INTERVAL_SECONDS}</integer>`);
  expect(plist).toContain('<key>ProcessType</key><string>Background</string>');
  expect(plist).toContain('<key>WorkingDirectory</key><string>/fixture/configured-home</string>');
  expect(plist).toContain('<key>SESSIONS_CLAUDE_DIR</key>');
  expect(plist).not.toContain('<string>./transcripts</string>');
  expect(plist).not.toContain('never-persist-this');
  expect(plist).not.toContain('KeepAlive');
});

test('launchd retains new native source overrides and drops retired Pi overrides', () => {
  const paths = [
    'SESSIONS_CODEX_ARCHIVED_DIR',
    'SESSIONS_CURSOR_DIR',
    'SESSIONS_CURSOR_IDE_DIR',
    'SESSIONS_ANTIGRAVITY_DIR',
    'SESSIONS_NATIVE_HOME',
  ];
  const environment = Object.fromEntries(paths.map((key) => [key, '/fixture/' + key]));
  const plist = renderLaunchAgent(['/fixture/pacifico', 'daemon', 'run'], {
    ...environment,
    SESSIONS_PI_DIR: '/retired/source',
    PI_CODING_AGENT_DIR: '/retired/agent',
  });
  for (const key of paths) expect(plist).toContain(`<key>${key}</key><string>/fixture/${key}</string>`);
  expect(plist).not.toContain('/retired/');
});

test('a failed document refresh records failure and a later daemon pass recovers', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { runDaemonPass } = await import('./daemon');
  const { closeDb } = await import('@pacifico/core/cache');
  const root = mkdtempSync(join(tmpdir(), 'pacifico-daemon-retry-'));
  const environment = Object.fromEntries([
    ['SESSIONS_HOME', root],
    ['SESSIONS_NATIVE_HOME', root],
    ['SESSIONS_DATA_DIR', join(root, 'data')],
    ['SESSIONS_ARCHIVE_DIR', join(root, 'archive')],
    ['SESSIONS_CACHE_DIR', join(root, 'cache')],
    ...[
      'CLAUDE_DIR',
      'CODEX_DIR',
      'CODEX_ARCHIVED_DIR',
      'CURSOR_DIR',
      'CURSOR_IDE_DIR',
      'ANTIGRAVITY_DIR',
      'OPENCODE_DB',
    ].map((key) => ['SESSIONS_' + key, join(root, key)]),
  ]);
  const prior = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  closeDb();
  try {
    const directory = join(root, 'archive/native-documents');
    mkdirSync(directory, { recursive: true });
    const corrupt = join(directory, 'a'.repeat(64) + '.json');
    writeFileSync(corrupt, '{invalid');
    await expect(runDaemonPass()).rejects.toThrow();
    const state = join(root, 'data/daemon-state.json');
    expect(JSON.parse(readFileSync(state, 'utf8')).ok).toBe(false);
    rmSync(corrupt);
    await runDaemonPass();
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ ok: true, total: 0 });
  } finally {
    closeDb();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
