import { expect, test } from 'bun:test';
import { renderLaunchAgent, DAEMON_INTERVAL_SECONDS } from './daemon';

test('launchd receives escaped argv, a bounded schedule, and only explicit configuration', () => {
  const plist = renderLaunchAgent(['/path with spaces/A&B/pacifico', 'daemon', 'run'], {
    PATH: '/usr/bin:/bin',
    SESSIONS_CLAUDE_DIR: './transcripts',
    ANTHROPIC_API_KEY: 'never-persist-this',
  });
  expect(plist).toContain('<string>/path with spaces/A&amp;B/pacifico</string>');
  expect(plist).toContain(`<key>StartInterval</key><integer>${DAEMON_INTERVAL_SECONDS}</integer>`);
  expect(plist).toContain('<key>ProcessType</key><string>Background</string>');
  expect(plist).toContain('<key>SESSIONS_CLAUDE_DIR</key>');
  expect(plist).not.toContain('<string>./transcripts</string>');
  expect(plist).not.toContain('never-persist-this');
  expect(plist).not.toContain('KeepAlive');
});
