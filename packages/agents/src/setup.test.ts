import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeLegacyHook } from './legacy-hook';
import { PLUGIN_FILES } from './plugin-files';

test('hook upgrade removes only Pacifico commands, including mixed matcher groups', () => {
  const root = mkdtempSync(join(tmpdir(), 'pacifico-hook-upgrade-'));
  const path = join(root, 'settings.json');
  try {
    const other = { type: 'command', command: 'echo preserve-me' };
    const retired = { type: 'command', command: 'pacifico context --hook' };
    const inherited = { type: 'command', command: 'sessions context --hook' };
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [retired, other] }, { hooks: [retired] }, { hooks: [inherited] }],
          Stop: [{ hooks: [other] }],
        },
      }),
    );
    expect(removeLegacyHook(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      permissions: { allow: ['Read'] },
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [other] }, { hooks: [inherited] }],
        Stop: [{ hooks: [other] }],
      },
    });
    expect(removeLegacyHook(path)).toBe(false);
    writeFileSync(path, 'invalid-json');
    expect(removeLegacyHook(path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('invalid-json');
    rmSync(path);
    expect(removeLegacyHook(path)).toBe(false);
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('embedded integrations ship MCP configuration without skills or prompts', () => {
  expect(Object.keys(PLUGIN_FILES).some((path) => path.startsWith('skills/'))).toBe(false);
  expect(PLUGIN_FILES['.mcp.json']).toContain('pacifico');
  expect(JSON.parse(PLUGIN_FILES['.codex-plugin/plugin.json']!).skills).toBeUndefined();
});
