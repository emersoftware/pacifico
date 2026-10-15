import { readCodexRollout } from '../sources/codex-rollout';
// Durable transcript snapshots outlive native source cleanup and index rebuilds.
// The manifest retains source identity; each file stores the latest archived content.
// Conversation records and aggregated accounting are compressed into shared objects.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { storeArchive, readArchive } from './blob';
import { compactTranscript } from './compact';
export { readArchive } from './blob';
import { type Tool } from '../types';
import { getArchiveDir } from '../paths';
import { serializeOpencodeSession } from '../opencode';

export { getArchiveDir };

export interface VaultEntry {
  tool: Tool | 'pi';
  cwd: string;
  sessionId: string;
  mtime: number; // source mtime at archive time
  size: number; // source size at archive time
  archivedAt: string; // ISO
  vaultPath: string; // absolute path of the copy
  storageVersion?: number;
  vaultMtime?: number;
  vaultSize?: number;
}

/** original file_path → its vault entry. */
export type Manifest = Record<string, VaultEntry>;

/** The manifest lives beside the per-tool copy dirs, one per vault. */
export function getManifestPath(dir: string): string {
  return join(dir, 'manifest.json');
}

/**
 * Read the manifest. Missing file → {}, malformed/wrong-shape → {} - never throws,
 * manifest validation. A corrupt manifest is treated as
 * empty and rebuilt by the refresh backfill pass; the vault copies themselves are
 * untouched by the manifest being unreadable.
 */
const vaultEntrySchema = z.object({
  tool: z.enum(['claude', 'pi', 'codex', 'opencode', 'cursor', 'antigravity']),
  cwd: z.string(),
  sessionId: z.string(),
  mtime: z.number(),
  size: z.number(),
  archivedAt: z.string(),
  vaultPath: z.string(),
  storageVersion: z.number().optional(),
  vaultMtime: z.number().optional(),
  vaultSize: z.number().optional(),
});

const manifestFileSchema = z.record(z.string(), z.unknown());

export function loadManifest(dir: string, strict = false): Manifest {
  const path = getManifestPath(dir);
  if (!existsSync(path)) return {};
  let parsed: z.infer<typeof manifestFileSchema>;
  try {
    const file = manifestFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    if (!file.success) {
      if (strict) throw new Error('Invalid archive manifest');
      return {};
    }
    parsed = file.data;
  } catch (error) {
    if (strict) throw error;
    return {};
  }
  const entries: Array<[string, VaultEntry]> = [];
  for (const [key, value] of Object.entries(parsed)) {
    const entry = vaultEntrySchema.safeParse(value);
    if (entry.success) entries.push([key, entry.data]);
    else if (strict) throw new Error(`Invalid archive manifest entry: ${key}`);
  }
  return Object.fromEntries(entries);
}

/**
 * Write the manifest atomically: a full write to a sibling tmp file then a rename,
 * so a crash mid-write can never leave a half-written manifest (rename is atomic on
 * the same filesystem). There is no shared atomic-write helper in this codebase, so
 * this owns the tmp+rename itself.
 */
export function saveManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  const path = getManifestPath(dir);
  const tmp = path + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  removeRetired(dir, manifest);
}

/**
 * Compact and compress a transcript, mutating the manifest in place. Returns true
 * when it published a snapshot, false when it skipped an unchanged source.
 *
 * Latest-snapshot: overwrite when the stored mtime/size differ from the source's,
 * skip when identical - mirroring the index's own change detection. The manifest is
 * saved once per refresh by the caller (never per file), so this only mutates the
 * in-memory map.
 *
 * Native sources are never edited. Unrecognized snapshots remain losslessly compressed.
 * A file that is itself inside the vault is never archived (self-copy guard).
 */
export function archiveFile(
  entry: { path: string; tool: Tool },
  parsed: { cwd: string; sessionId: string },
  stat: { mtime: number; size: number },
  manifest: Manifest,
  dir: string = getArchiveDir(),
  snapshot?: string | Buffer,
): boolean {
  const inside = relative(dir, entry.path);
  if (inside === '' || (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))) return false;

  const existing = manifest[entry.path];
  if (existing && existing.mtime === stat.mtime && existing.size === stat.size && existsSync(existing.vaultPath))
    return false;

  let content: string;
  if (snapshot !== undefined) {
    if (!snapshot.length) throw new Error('Native transcript is empty');
    content = snapshot.toString();
  } else if (entry.tool === 'cursor' || entry.tool === 'antigravity') {
    throw new Error('A captured transcript is required for this source.');
  } else if (entry.tool === 'codex') content = readCodexRollout(entry.path).toString('utf8');
  else if (entry.tool === 'opencode') content = serializeOpencodeSession(entry.path);
  else content = readFileSync(entry.path, 'utf8');
  const vaultPath = writeCompactArchive(dir, content, entry.tool, entry.path);
  if (existing && existing.vaultPath !== vaultPath) retire(manifest, existing.vaultPath);

  manifest[entry.path] = {
    tool: entry.tool,
    cwd: parsed.cwd,
    sessionId: parsed.sessionId,
    mtime: stat.mtime,
    size: stat.size,
    archivedAt: new Date().toISOString(),
    vaultPath,
    storageVersion: 1,
    vaultMtime: stat.mtime,
    vaultSize: stat.size,
  };
  return true;
}

/**
 * Manifest entries whose vault copy still exists on disk, as discovery candidates.
 * An entry whose vaultPath was deleted is skipped: with both the source and the
 * vault copy gone, the index row is genuinely prunable.
 */
export function listArchived(dir: string): Array<{ path: string; tool: Tool | 'pi'; vaultPath: string }> {
  const manifest = loadManifest(dir);
  const out: Array<{ path: string; tool: Tool | 'pi'; vaultPath: string }> = [];
  for (const [path, entry] of Object.entries(manifest)) {
    if (existsSync(entry.vaultPath)) out.push({ path, tool: entry.tool, vaultPath: entry.vaultPath });
  }
  return out;
}

/** The byte size of a vault copy, or 0 when it is unreadable (used by `vault status`). */
export function vaultFileSize(vaultPath: string): number {
  try {
    return statSync(vaultPath).size;
  } catch {
    return 0;
  }
}

// Old copies are removed only after the new manifest has been published.
const retired = new WeakMap<Manifest, Set<string>>();
export function retire(manifest: Manifest, path: string): void {
  const paths = retired.get(manifest) ?? new Set<string>();
  paths.add(path);
  retired.set(manifest, paths);
}
function removeRetired(dir: string, manifest: Manifest): void {
  const referenced = new Set(Object.values(manifest).map((entry) => entry.vaultPath));
  for (const path of retired.get(manifest) ?? []) {
    const rel = relative(dir, path);
    if (!referenced.has(path) && rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      // Managed objects are collected after a reader grace period by maintenance.
      if (rel.startsWith('objects/')) continue;
      rmSync(path, { force: true });
    }
  }
  retired.delete(manifest);
}
export function writeCompactArchive(dir: string, text: string, tool: Tool, sourcePath: string): string {
  let compacted: string;
  try {
    compacted = compactTranscript(text, tool, sourcePath);
  } catch {
    compacted = text;
  } // Unknown or malformed sources remain losslessly compressed.
  return storeArchive(dir, compacted);
}

/** Caller holds the refresh lock. Migration never reopens a missing native source. */
export function migrateArchive(dir: string, manifest: Manifest, limit = 4): number {
  let migrated = 0;
  for (const [path, entry] of Object.entries(manifest)) {
    if (entry.storageVersion === 1 || entry.tool === 'pi') continue;
    if (!existsSync(entry.vaultPath)) continue;
    const old = entry.vaultPath;
    const priorStat = statSync(old);
    const text = readArchive(old);
    entry.vaultPath = writeCompactArchive(dir, text, entry.tool, path);
    entry.storageVersion = 1;
    // A representation change does not invalidate already indexed messages.
    entry.vaultMtime = priorStat.mtimeMs;
    entry.vaultSize = priorStat.size;
    retire(manifest, old);
    migrated++;
    if (migrated >= limit) break;
  }
  return migrated;
}
