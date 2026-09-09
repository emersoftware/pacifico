import { readCodexRollout } from '../sources/codex-rollout';
// Durable transcript snapshots outlive native source cleanup and index rebuilds.
// The manifest retains source identity; each file stores the latest archived content.
// File-backed sessions retain native bytes. OpenCode exports its database records.

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  rmSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
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
}

/** original file_path → its vault entry. */
export type Manifest = Record<string, VaultEntry>;

/** The manifest lives beside the per-tool copy dirs, one per vault. */
export function getManifestPath(dir: string): string {
  return join(dir, 'manifest.json');
}

/** A path digest avoids collisions between directory separators and literal dashes. */
function encodePath(originalPath: string): string {
  return createHash('sha256').update(originalPath).digest('hex') + '.jsonl';
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
});

const manifestFileSchema = z.record(z.string(), z.unknown());

export function loadManifest(dir: string): Manifest {
  const path = getManifestPath(dir);
  if (!existsSync(path)) return {};
  let parsed: z.infer<typeof manifestFileSchema>;
  try {
    const file = manifestFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    if (!file.success) return {};
    parsed = file.data;
  } catch {
    return {};
  }
  const entries: Array<[string, VaultEntry]> = [];
  for (const [key, value] of Object.entries(parsed)) {
    const entry = vaultEntrySchema.safeParse(value);
    if (entry.success) entries.push([key, entry.data]);
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
  renameSync(tmp, path);
}

/**
 * Copy one transcript into the vault, mutating `manifest` in place. Returns true when
 * it wrote (or overwrote) a copy, false when it skipped an unchanged one.
 *
 * Latest-snapshot: overwrite when the stored mtime/size differ from the source's,
 * skip when identical - mirroring the index's own change detection. The manifest is
 * saved once per refresh by the caller (never per file), so this only mutates the
 * in-memory map.
 *
 * OpenCode is serialized from its DB rows; every other tool is a raw byte copy.
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
  if (existing && existing.mtime === stat.mtime && existing.size === stat.size) return false;

  const toolDir = join(dir, entry.tool);
  const vaultPath = join(toolDir, encodePath(entry.path));
  mkdirSync(toolDir, { recursive: true });
  // A stopped background worker must not leave a partially overwritten archive.
  // Readers keep seeing the previous complete copy until the rename commits it.
  const temporary = `${vaultPath}.tmp-${process.pid}`;
  try {
    if (snapshot !== undefined) {
      if (!snapshot.length) throw new Error('Native transcript is empty');
      writeFileSync(temporary, snapshot);
    } else if (entry.tool === 'cursor' || entry.tool === 'antigravity') {
      throw new Error('A captured transcript is required for this source.');
    } else if (entry.tool === 'codex') {
      writeFileSync(temporary, readCodexRollout(entry.path));
    } else if (entry.tool === 'opencode') {
      writeFileSync(temporary, serializeOpencodeSession(entry.path));
    } else {
      copyFileSync(entry.path, temporary);
    }
    renameSync(temporary, vaultPath);
  } finally {
    rmSync(temporary, { force: true });
  }

  manifest[entry.path] = {
    tool: entry.tool,
    cwd: parsed.cwd,
    sessionId: parsed.sessionId,
    mtime: stat.mtime,
    size: stat.size,
    archivedAt: new Date().toISOString(),
    vaultPath,
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
