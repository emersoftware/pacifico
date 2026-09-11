import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { getHome } from '@pacifico/core/paths';
import { createHash } from 'node:crypto';

export const HARNESS_IDS = ['claude', 'codex', 'cursor', 'antigravity', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a configuration object.');
  return value as ObjectValue;
}
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable(object(value)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

export function locations(harness: HarnessId, project?: string): { config: string; skills: string[] } {
  const home = getHome();
  const codex = process.env.CODEX_HOME || join(home, '.codex');
  const claude = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const base = project ?? home;
  const configs: Record<HarnessId, string> = {
    claude: project ? join(project, '.mcp.json') : join(home, '.claude.json'),
    codex: join(project ? join(project, '.codex') : codex, 'config.toml'),
    cursor: join(base, '.cursor/mcp.json'),
    antigravity: project ? join(project, '.agents/mcp_config.json') : join(home, '.gemini/config/mcp_config.json'),
    opencode: join(project ?? join(xdg, 'opencode'), 'opencode.json'),
  };
  if (harness === 'opencode' && existsSync(configs.opencode + 'c')) configs.opencode += 'c';
  if (harness === 'antigravity' && !project && !existsSync(configs.antigravity)) {
    const legacy = join(home, '.gemini/antigravity/mcp_config.json');
    if (existsSync(legacy)) configs.antigravity = legacy;
  }
  const skills: Record<HarnessId, string[]> = project
    ? {
        claude: [join(base, '.claude/skills')],
        codex: [join(base, '.agents/skills'), join(base, '.codex/skills')],
        cursor: [join(base, '.agents/skills'), join(base, '.cursor/skills')],
        antigravity: [join(base, '.agents/skills'), join(base, '.agent/skills')],
        opencode: [join(base, '.agents/skills'), join(base, '.opencode/skills')],
      }
    : {
        claude: [join(claude, 'skills')],
        codex: [join(home, '.agents/skills'), join(codex, 'skills')],
        cursor: [join(home, '.cursor/skills')],
        antigravity: [join(home, '.gemini/antigravity/skills')],
        opencode: [join(xdg, 'opencode/skills'), join(home, '.agents/skills')],
      };
  return { config: configs[harness], skills: skills[harness] };
}

export function parseConfig(text: string, harness: HarnessId): ObjectValue {
  if (harness === 'codex') {
    try {
      return object(Bun.TOML.parse(text));
    } catch {
      throw new Error('Invalid TOML configuration; no changes written.');
    }
  }
  const errors: ParseError[] = [];
  const result: unknown = parse(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid JSON/JSONC configuration; no changes written.');
  return object(result);
}
export function configText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
export function serverMap(config: ObjectValue, harness: HarnessId): ObjectValue {
  return object(config[harness === 'codex' ? 'mcp_servers' : harness === 'opencode' ? 'mcp' : 'mcpServers'] ?? {});
}

/** Normalize only portable fields. Unsupported options remain visible as a refusal. */
export function normalizeServer(value: unknown, harness: HarnessId): ObjectValue {
  const entry = object(value);
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((part) => typeof part !== 'string')))
    throw new Error('Invalid MCP arguments.');
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('Invalid MCP enabled state.');
  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean')
    throw new Error('Invalid MCP disabled state.');
  if (entry.command !== undefined && (entry.url !== undefined || entry.serverUrl !== undefined))
    throw new Error('MCP entry declares more than one transport.');
  const allowed = new Set([
    'command',
    'args',
    'env',
    'url',
    'headers',
    'cwd',
    'type',
    'enabled',
    'disabled',
    ...(harness === 'opencode' ? ['environment'] : []),
    ...(harness === 'codex' ? ['http_headers'] : []),
    ...(harness === 'antigravity' ? ['serverUrl'] : []),
  ]);
  if (Object.keys(entry).some((key) => !allowed.has(key)))
    throw new Error('Contains harness-specific options; configure this server separately.');
  const out: ObjectValue = {};
  if (entry.command !== undefined) {
    const command =
      harness === 'opencode' ? entry.command : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string'))
      throw new Error('Invalid MCP command.');
    out.command = command[0];
    out.args = command.slice(1);
  } else {
    const url = entry.serverUrl ?? entry.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Unsupported MCP transport.');
    if (entry.type === 'sse') throw new Error('Explicit SSE transport needs manual configuration for each harness.');
    out.url = url;
  }
  for (const [destination, source] of [
    ['env', entry.environment ?? entry.env],
    ['headers', entry.http_headers ?? entry.headers],
  ] as const) {
    if (source === undefined) continue;
    const map = object(source);
    if (Object.values(map).some((value) => typeof value !== 'string'))
      throw new Error('MCP environment and headers must contain strings.');
    if (Object.values(map).some((value) => /\$\{|\{env:|\{file:/.test(String(value))))
      throw new Error('Environment/file interpolation differs between harnesses; configure this server separately.');
    if (Object.keys(map).length) out[destination] = map;
  }
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== 'string') throw new Error('Invalid MCP working directory.');
    out.cwd = entry.cwd;
  }
  if (entry.enabled === false || entry.disabled === true) out.enabled = false;
  return out;
}

export function encodeServer(server: ObjectValue, harness: HarnessId): ObjectValue {
  const out: ObjectValue = { ...server };
  if (harness === 'opencode') {
    out.type = out.command ? 'local' : 'remote';
    if (out.command) {
      out.command = [out.command, ...(out.args as string[])];
      delete out.args;
    }
    if (out.env) {
      out.environment = out.env;
      delete out.env;
    }
  } else if (harness === 'codex') {
    if (out.headers) {
      out.http_headers = out.headers;
      delete out.headers;
    }
  } else {
    if (out.enabled === false) {
      out.disabled = true;
      delete out.enabled;
    }
    if (harness === 'claude') {
      if (out.disabled) throw new Error('Claude disabled-server state is not portable in this configuration file.');
      out.type = out.command ? 'stdio' : 'http';
    }
    if (harness === 'antigravity' && out.url) {
      out.serverUrl = out.url;
      delete out.url;
    }
  }
  return out;
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (value && typeof value === 'object')
    return (
      '{ ' +
      Object.entries(object(value))
        .map(([key, item]) => JSON.stringify(key) + ' = ' + toml(item))
        .join(', ') +
      ' }'
    );
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  throw new Error('Unsupported TOML value.');
}

export function setServer(text: string, harness: HarnessId, name: string, value: ObjectValue): string {
  if (harness !== 'codex') {
    return applyEdits(
      text || '{}\n',
      modify(text || '{}\n', [harness === 'opencode' ? 'mcp' : 'mcpServers', name], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  }
  const config = parseConfig(text, harness);
  const marker = '# pacifico-sync ' + hash(name);
  const start = text.indexOf(marker + ' begin\n');
  const end = text.indexOf(marker + ' end\n');
  if (serverMap(config, harness)[name] !== undefined && (start < 0 || end < start))
    throw new Error('Existing Codex entry is not managed by Pacifico; left unchanged.');
  const rest = start >= 0 ? text.slice(0, start) + text.slice(end + (marker + ' end\n').length) : text;
  const result =
    rest +
    '\n' +
    marker +
    ' begin\n' +
    `[mcp_servers.${JSON.stringify(name)}]\n` +
    Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}\n`)
      .join('') +
    marker +
    ' end\n';
  const expected = structuredClone(config);
  expected.mcp_servers = { ...serverMap(config, harness), [name]: value };
  if (stable(parseConfig(result, harness)) !== stable(expected))
    throw new Error('TOML edit would change unrelated settings.');
  return result;
}
