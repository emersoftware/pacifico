import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDataDir } from '@pacifico/core/paths';
import {
  configText,
  encodeServer,
  hash,
  locations,
  normalizeServer,
  object,
  parseConfig,
  serverMap,
  setServer,
  stable,
  type HarnessId,
} from './formats';

type Skill = { path: string; files: Map<string, { bytes: Buffer; mode: number }>; hash: string };
type Manifest = Record<string, string>;
export interface SyncOptions {
  from: HarnessId;
  to: HarnessId[];
  project?: string;
  kind?: 'skills' | 'mcp';
  names?: string[];
  apply?: boolean;
  skillsDirectory?: string;
  configFile?: string;
}
export interface SyncItem {
  harness: HarnessId;
  kind: 'skills' | 'mcp';
  name: string;
  status: 'create' | 'update' | 'unchanged' | 'conflict' | 'unsupported';
  reason?: string;
}

function readSkill(path: string): Skill {
  const root = realpathSync(path);
  const files = new Map<string, { bytes: Buffer; mode: number }>();
  const visited = new Set<string>();
  function walk(directory: string) {
    const actual = realpathSync(directory);
    if (actual !== root && !actual.startsWith(root + '/'))
      throw new Error('Skill has a link outside its own directory.');
    if (visited.has(actual)) throw new Error('Skill has a cyclic or repeated directory link.');
    visited.add(actual);
    for (const entry of readdirSync(directory).sort()) {
      if (entry === '.git') continue;
      const full = join(directory, entry),
        real = realpathSync(full);
      if (!real.startsWith(root + '/')) throw new Error('Skill has a link outside its own directory.');
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) files.set(relative(path, full), { bytes: readFileSync(full), mode: info.mode & 0o777 });
      else throw new Error('Unsupported file type in skill.');
    }
  }
  walk(path);
  if (!files.has('SKILL.md')) throw new Error('Skill is missing SKILL.md.');
  return {
    path,
    files,
    hash: hash(
      [...files].map(([name, file]) => `${name}:${file.mode}:${hash(file.bytes.toString('base64'))}`).join('\n'),
    ),
  };
}

function skillPaths(roots: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      if (name.startsWith('.') || !existsSync(join(root, name, 'SKILL.md'))) continue;
      const path = join(root, name);
      const previous = result.get(name);
      if (
        previous &&
        realpathSync(previous) !== realpathSync(path) &&
        readSkill(previous).hash !== readSkill(path).hash
      )
        throw new Error(`Conflicting skill copies for ${name}; choose one version before syncing.`);
      if (!previous) result.set(name, path);
    }
  }
  return result;
}

function stateFor(source: string, destination: string | undefined, previous: string | undefined): SyncItem['status'] {
  if (destination === undefined) return 'create';
  if (source === destination) return 'unchanged';
  return previous === destination ? 'update' : 'conflict';
}

/** Plan first; apply only explicitly, retaining backups and destination edits. */
export function syncConfiguration(options: SyncOptions): { applied: boolean; items: SyncItem[]; backup?: string } {
  const project = options.project ? resolve(options.project) : undefined;
  const statePath = join(getDataDir(), 'config-sync.json');
  const manifest = existsSync(statePath) ? (object(JSON.parse(readFileSync(statePath, 'utf8'))) as Manifest) : {};
  const source = locations(options.from, project);
  if (options.skillsDirectory) {
    if (options.kind !== 'skills') throw new Error('--skills-dir requires --kind skills.');
    source.skills = [resolve(options.skillsDirectory)];
    if (!existsSync(source.skills[0]!)) throw new Error('The source skills directory does not exist.');
  }
  if (options.configFile) {
    if (options.kind !== 'mcp') throw new Error('--config-file requires --kind mcp.');
    source.config = resolve(options.configFile);
    if (!existsSync(source.config)) throw new Error('The source MCP configuration file does not exist.');
  }
  const chosen = (name: string) => !options.names?.length || options.names.includes(name);
  const items: SyncItem[] = [];
  const writes = new Map<string, { before: string; after: string }>();
  const copies: { target: string; skill: Skill; previous?: string; key: string }[] = [];
  const next = { ...manifest };
  for (const targetHarness of new Set(options.to)) {
    if (targetHarness === options.from) continue;
    const target = locations(targetHarness, project);
    if (options.kind !== 'mcp') {
      const dest = skillPaths(target.skills);
      for (const [name, path] of skillPaths(source.skills)) {
        if (!chosen(name)) continue;
        try {
          const skill = readSkill(path),
            targetPath = dest.get(name) ?? join(target.skills[0]!, name);
          const previous = dest.has(name) ? readSkill(targetPath).hash : undefined;
          const key = `skills:${targetPath}`;
          let status = stateFor(skill.hash, previous, manifest[key]);
          if (status === 'update' && lstatSync(targetPath).isSymbolicLink()) status = 'conflict';
          items.push({ harness: targetHarness, kind: 'skills', name, status });
          if (status === 'create' || status === 'update') copies.push({ target: targetPath, skill, previous, key });
        } catch (error) {
          items.push({
            harness: targetHarness,
            kind: 'skills',
            name,
            status: 'unsupported',
            reason: error instanceof Error ? error.message : 'Unreadable skill.',
          });
        }
      }
    }
    if (options.kind !== 'skills') {
      const original = configText(target.config);
      const servers = serverMap(parseConfig(configText(source.config), options.from), options.from);
      const destinations = serverMap(parseConfig(original, targetHarness), targetHarness);
      for (const [name, value] of Object.entries(servers)) {
        if (!chosen(name)) continue;
        try {
          const normalized = normalizeServer(value, options.from);
          const targetValue = encodeServer(normalized, targetHarness);
          const targetHash =
            destinations[name] === undefined
              ? undefined
              : hash(stable(normalizeServer(destinations[name], targetHarness)));
          const sourceHash = hash(stable(normalized));
          const key = `mcp:${target.config}:${name}`;
          const status = stateFor(sourceHash, targetHash, manifest[key]);
          if (status === 'create' || status === 'update') {
            const after = setServer(writes.get(target.config)?.after ?? original, targetHarness, name, targetValue);
            writes.set(target.config, { before: original, after });
            next[key] = sourceHash;
          }
          items.push({ harness: targetHarness, kind: 'mcp', name, status });
        } catch (error) {
          items.push({
            harness: targetHarness,
            kind: 'mcp',
            name,
            status: 'unsupported',
            reason: error instanceof Error ? error.message : 'Unsupported MCP configuration.',
          });
        }
      }
    }
  }
  if (!options.apply || items.some((item) => item.status === 'conflict')) return { applied: false, items };
  if (!writes.size && !copies.length) return { applied: true, items };
  mkdirSync(getDataDir(), { recursive: true });
  const lock = join(getDataDir(), 'config-sync.lock');
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  const backup = join(getDataDir(), 'backups', 'config-sync', randomUUID());
  const staged: {
    target: string;
    temp: string;
    directory: boolean;
    existed: boolean;
    moved: boolean;
    committed: boolean;
  }[] = [];
  try {
    const currentManifest = existsSync(statePath) ? object(JSON.parse(readFileSync(statePath, 'utf8'))) : {};
    if (stable(currentManifest) !== stable(manifest)) throw new Error('Sync state changed. Run the preview again.');
    for (const [path, edit] of writes) {
      if (configText(path) !== edit.before || (existsSync(path) && lstatSync(path).isSymbolicLink()))
        throw new Error('Destination configuration changed or is a symlink. Run the preview again.');
    }
    const uniqueCopies = [...new Map(copies.map((copy) => [copy.target, copy])).values()];
    for (const copy of uniqueCopies) {
      const current = existsSync(copy.target) ? readSkill(copy.target).hash : undefined;
      if (current !== copy.previous) throw new Error('Destination skill changed. Run the preview again.');
    }
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const [path, edit] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) writeFileSync(join(backup, hash(path)), edit.before, { mode: 0o600 });
      const temp = path + '.pacifico-' + randomUUID();
      staged.push({ target: path, temp, directory: false, existed: existsSync(path), moved: false, committed: false });
      writeFileSync(temp, edit.after, { mode: 0o600, flag: 'wx' });
    }
    for (const copy of uniqueCopies) {
      const temp = copy.target + '.pacifico-' + randomUUID();
      staged.push({
        target: copy.target,
        temp,
        directory: true,
        existed: existsSync(copy.target),
        moved: false,
        committed: false,
      });
      mkdirSync(temp, { recursive: true });
      for (const [name, file] of copy.skill.files) {
        const path = join(temp, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.bytes, { mode: file.mode });
      }
      next[copy.key] = copy.skill.hash;
    }
    writeFileSync(
      join(backup, 'paths.json'),
      JSON.stringify(
        {
          files: [...writes.keys()].map((path) => ({ path, backup: hash(path) })),
          skills: uniqueCopies.map((copy) => ({ path: copy.target, backup: hash(copy.target) })),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const temp = statePath + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    try {
      for (const entry of staged) {
        if (entry.directory && entry.existed) {
          renameSync(entry.target, join(backup, hash(entry.target)));
          entry.moved = true;
        }
        renameSync(entry.temp, entry.target);
        entry.committed = true;
      }
      renameSync(temp, statePath);
    } catch (error) {
      for (const entry of [...staged].reverse()) {
        if (entry.committed) rmSync(entry.target, { force: true, recursive: entry.directory });
        if (entry.moved) renameSync(join(backup, hash(entry.target)), entry.target);
        else if (entry.committed && entry.existed)
          writeFileSync(entry.target, readFileSync(join(backup, hash(entry.target))), { mode: 0o600 });
      }
      rmSync(temp, { force: true });
      throw error;
    }
    return { applied: true, items, backup };
  } finally {
    for (const entry of staged) rmSync(entry.temp, { force: true, recursive: entry.directory });
    rmSync(lock, { force: true });
  }
}
