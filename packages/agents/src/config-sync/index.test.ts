import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncConfiguration } from './index';
import { configText, locations, parseConfig, serverMap } from './formats';

let root: string, original: string | undefined;
function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function source(args = ['--mcp']) {
  write(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { example: { command: 'pacifico', args, env: { PRIVATE_VALUE: 'not-for-output' } } },
    }),
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pacifico-config-sync-'));
  original = process.env.SESSIONS_DATA_DIR;
  process.env.SESSIONS_DATA_DIR = join(root, 'data');
  source();
  write(
    join(root, '.claude/skills/example/SKILL.md'),
    '---\nname: example\ndescription: Example\n---\nRead references/detail.md\n',
  );
  write(join(root, '.claude/skills/example/references/detail.md'), 'Full reference\n');
});
afterEach(() => {
  if (original === undefined) delete process.env.SESSIONS_DATA_DIR;
  else process.env.SESSIONS_DATA_DIR = original;
  rmSync(root, { recursive: true, force: true });
});
test('preview is read-only and application converts all five harnesses without exposing values', () => {
  const options = {
    from: 'claude' as const,
    to: ['codex', 'cursor', 'antigravity', 'opencode'] as const,
    project: root,
  };
  const preview = syncConfiguration({ ...options, to: [...options.to] });
  expect(preview.items).toHaveLength(8);
  expect(JSON.stringify(preview)).not.toContain('not-for-output');
  expect(existsSync(join(root, '.codex'))).toBe(false);
  expect(existsSync(join(root, 'data'))).toBe(false);
  const result = syncConfiguration({ ...options, to: [...options.to], apply: true });
  expect(result.applied).toBe(true);
  expect(readFileSync(join(root, '.agents/skills/example/references/detail.md'), 'utf8')).toBe('Full reference\n');
  const open = serverMap(parseConfig(configText(locations('opencode', root).config), 'opencode'), 'opencode');
  expect(open.example).toEqual({
    type: 'local',
    command: ['pacifico', '--mcp'],
    environment: { PRIVATE_VALUE: 'not-for-output' },
  });
  expect(
    syncConfiguration({ ...options, to: [...options.to] }).items.every((item) => item.status === 'unchanged'),
  ).toBe(true);
});
test('managed changes update, preserve TOML comments, and edits in destination block the whole apply', () => {
  write(join(root, '.codex/config.toml'), '# Keep this comment\nmodel = "test-model"\n');
  const options = { from: 'claude' as const, to: ['codex' as const], project: root, apply: true };
  syncConfiguration(options);
  source(['--mcp', '--changed']);
  const updated = syncConfiguration(options);
  expect(updated.items.find((item) => item.kind === 'mcp')?.status).toBe('update');
  expect(readFileSync(join(root, '.codex/config.toml'), 'utf8')).toContain('# Keep this comment');
  write(join(root, '.agents/skills/example/references/detail.md'), 'User changed this\n');
  write(join(root, '.claude/skills/example/references/detail.md'), 'Source changed too\n');
  const conflicted = syncConfiguration(options);
  expect(conflicted.applied).toBe(false);
  expect(conflicted.items.some((item) => item.status === 'conflict')).toBe(true);
  expect(readFileSync(join(root, '.agents/skills/example/references/detail.md'), 'utf8')).toBe('User changed this\n');
});
test('remote MCP URLs convert to Antigravity serverUrl and back', () => {
  write(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer test-only' } },
      },
    }),
  );
  syncConfiguration({ from: 'claude', to: ['antigravity'], project: root, kind: 'mcp', apply: true });
  const map = serverMap(parseConfig(configText(locations('antigravity', root).config), 'antigravity'), 'antigravity');
  expect(map.remote).toEqual({ serverUrl: 'https://example.com/mcp', headers: { Authorization: 'Bearer test-only' } });
  expect(syncConfiguration({ from: 'antigravity', to: ['claude'], project: root, kind: 'mcp' }).items[0]!.status).toBe(
    'unchanged',
  );
});
test('refuses unsupported options and external skill links without changing configurations', () => {
  write(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { private: { command: 'test', unknownOption: 'test-secret' } } }),
  );
  write(join(root, 'external.md'), 'External');
  symlinkSync(join(root, 'external.md'), join(root, '.claude/skills/example/external.md'));
  const result = syncConfiguration({ from: 'claude', to: ['cursor'], project: root, apply: true });
  expect(result.items.every((item) => item.status === 'unsupported')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('test-secret');
  expect(existsSync(join(root, '.cursor'))).toBe(false);
});
test('JSONC comments survive adding a server', () => {
  write(join(root, 'opencode.jsonc'), '{\n // Keep me\n "theme": "system",\n}\n');
  syncConfiguration({ from: 'claude', to: ['opencode'], project: root, kind: 'mcp', apply: true });
  const output = readFileSync(join(root, 'opencode.jsonc'), 'utf8');
  expect(output).toContain('// Keep me');
  expect(parseConfig(output, 'opencode').theme).toBe('system');
});

test('an explicit plugin directory supplies skills without copying plugin configuration', () => {
  const plugin = join(root, 'plugin/skills');
  write(
    join(plugin, 'plugin-skill/SKILL.md'),
    '---\nname: plugin-skill\ndescription: A plugin skill\n---\nRead the project.\n',
  );
  const result = syncConfiguration({
    from: 'codex',
    to: ['claude'],
    project: root,
    kind: 'skills',
    skillsDirectory: plugin,
    apply: true,
  });
  expect(result.applied).toBe(true);
  expect(existsSync(join(root, '.claude/skills/plugin-skill/SKILL.md'))).toBe(true);
  expect(result.items.map((item) => item.name)).toEqual(['plugin-skill']);
});
