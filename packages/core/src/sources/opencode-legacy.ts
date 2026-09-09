import { Glob } from 'bun';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { asJsonNumber, asJsonObject, asJsonString, tryParse, type JsonObject } from '../extract-util';
import { buildContent, isoTime } from './opencode-content';

function list(root: string, pattern: string): string[] {
  if (!existsSync(root)) return [];
  return [...new Glob(pattern).scanSync({ cwd: root, absolute: true, followSymlinks: false })].sort();
}

export function isLegacyOpencodePath(path: string, database: string): boolean {
  const parts = relative(join(dirname(database), 'storage/session'), path).split(sep);
  return parts.length === 2 && parts[0] !== '..' && parts[1]!.endsWith('.json');
}

export function discoverLegacyOpencode(database: string): { path: string; tool: 'opencode' }[] {
  return list(join(dirname(database), 'storage/session'), '*/*.json').map((path) => ({ path, tool: 'opencode' }));
}

interface NativeFile {
  path: string;
  content: string;
  data: JsonObject;
  mtimeMs: number;
}

function read(path: string): NativeFile {
  const bytes = readFileSync(path);
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const data = tryParse(content);
  if (!data) throw new Error(`Invalid OpenCode JSON: ${path}`);
  return { path, content, data, mtimeMs: statSync(path).mtimeMs };
}

function safeId(id: string): string {
  if (!id || basename(id) !== id || id === '.' || id === '..' || id.includes('\\'))
    throw new Error('Invalid OpenCode record ID');
  return id;
}

// Keep the original JSON strings so unknown fields and numeric spellings survive.
function capture(path: string) {
  const session = read(path);
  const id = safeId(asJsonString(session.data.id) ?? basename(path, '.json'));
  const storage = dirname(dirname(dirname(path)));
  const messages = list(join(storage, 'message', id), '*.json').map(read);
  const parts = messages.flatMap((message) => {
    const messageId = safeId(asJsonString(message.data.id) ?? basename(message.path, '.json'));
    return list(join(storage, 'part', messageId), '*.json').map(read);
  });
  return { id, session, messages, parts };
}

function signature(snapshot: ReturnType<typeof capture>): string {
  return JSON.stringify([snapshot.session, ...snapshot.messages, ...snapshot.parts]);
}

function stableSnapshot(path: string): ReturnType<typeof capture> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = capture(path);
    const second = capture(path);
    if (signature(first) === signature(second)) return second;
  }
  throw new Error('OpenCode files changed during import');
}

export function statLegacyOpencode(path: string): { mtimeMs: number; size: number } | null {
  try {
    const snapshot = stableSnapshot(path);
    const files = [snapshot.session, ...snapshot.messages, ...snapshot.parts];
    return {
      mtimeMs: Math.max(...files.map((file) => file.mtimeMs)),
      // A content fingerprint detects part edits even when file lengths and mtimes are unchanged.
      size: Number.parseInt(createHash('sha256').update(signature(snapshot)).digest('hex').slice(0, 12), 16),
    };
  } catch {
    return null;
  }
}

export function readLegacyOpencode(path: string): string[] {
  if (!existsSync(path)) return [];
  const { id, session, messages, parts } = stableSnapshot(path);
  const created = asJsonNumber(asJsonObject(session.data.time)?.created);
  const lines = [
    JSON.stringify({
      type: 'source_records',
      source: 'opencode',
      format: 'json-storage',
      files: [session, ...messages, ...parts].map(({ path, content }) => ({ path, content })),
    }),
    JSON.stringify({
      type: 'session',
      sessionId: id,
      cwd: asJsonString(session.data.directory) ?? '',
      timestamp: isoTime(created),
    }),
  ];
  const title = asJsonString(session.data.title);
  if (title && !title.startsWith('New session'))
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: title }));
  messages.sort((a, b) => {
    const time =
      (asJsonNumber(asJsonObject(a.data.time)?.created) ?? 0) - (asJsonNumber(asJsonObject(b.data.time)?.created) ?? 0);
    return time || a.path.localeCompare(b.path);
  });
  for (const message of messages) {
    const messageId = asJsonString(message.data.id) ?? basename(message.path, '.json');
    const role = asJsonString(message.data.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const content = buildContent(
      parts.filter((part) => basename(dirname(part.path)) === messageId).map((part) => part.data),
    );
    if (!content.length) continue;
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp: isoTime(asJsonNumber(asJsonObject(message.data.time)?.created) ?? created),
        message: { role, content },
      }),
    );
  }
  return lines;
}
