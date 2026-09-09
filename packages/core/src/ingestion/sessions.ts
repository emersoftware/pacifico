import { antigravityGitVersion } from '../sources/antigravity-git';
import { tryParse, asJsonObject } from '../extract-util';
import { codexRolloutPath, readCodexRollout } from '../sources/codex-rollout';
import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { getDb, getDbPath, closeIndex } from '../storage/index';
import { antigravityDatabasePath } from '../sources/antigravity-history';
import { cursorIdeLocation, cursorIdeSessionExists } from '../sources/cursor-ide';
import { discoverNativeSessions } from '../sources/discovery';
import { acquireRefreshLock } from '../refresh-lock';
import type { Tool } from '../types';
import { getArchiveDir, getHome } from '../paths';
import { importDocuments } from './documents';
import { extractMessages, getSessionMessages, extractSessionMetadata, summarizeMessages } from '../parser';
import { extractFiles, extractFilesRead } from '../extract-files';
import { extractCommands } from '../extract-commands';
import { extractErrors } from '../extract-errors';
import { extractThinking } from '../extract-thinking';
import { closeOpencodeDb, opencodeStat } from '../opencode';
import { readSessionLines, statSession } from '../session-io';
import { archiveFile, listArchived, loadManifest, saveManifest, type Manifest } from '../vault/archive';

let _refreshPromise: Promise<RefreshResult> | null = null;
let _lastRefreshAt = 0;
let _lastRefreshResult: RefreshResult = { total: 0, updated: 0 };

interface RefreshResult {
  total: number;
  updated: number;
  archiveWarning?: true;
}

export function clearCache(): void {
  const dbPath = getDbPath();
  const files = [dbPath, dbPath + '-wal', dbPath + '-shm'];
  let cleared = false;
  for (const f of files) {
    try {
      require('node:fs').unlinkSync(f);
      cleared = true;
    } catch {}
  }
  process.stderr.write(cleared ? 'Cache cleared. It will rebuild on next use.\n' : 'No cache to clear.\n');
}

// Close and drop the cached connection so the next getDb() reopens against the
// current getDbPath(). Lets hermetic tests reset shared-module state between files
// (and release the handle before deleting a temp dir). Idempotent and never throws.
export function closeDb(): void {
  closeIndex();
  // Drop the in-flight refresh too: it targets the handle we just closed, so a
  // later ensureIndexFresh must start a new scan rather than join a doomed one.
  _refreshPromise = null;
  _lastRefreshAt = 0;
  _lastRefreshResult = { total: 0, updated: 0 };
  closeOpencodeDb();
}

interface FileEntry {
  path: string;
  tool: Tool;
}

async function discoverFiles(): Promise<FileEntry[]> {
  const entries = await discoverNativeSessions();

  // Vault-only sessions: transcripts whose live source is gone but whose archived
  // copy survives. Appended under their ORIGINAL path so they re-index with the same
  // identity; parsing reads through the session-io vault fallback. Skip any path a
  // live source already produced - a vendor-restored file wins over its vault entry.
  const live = new Set(entries.map((e) => e.path));
  for (const archived of listArchived(getArchiveDir())) {
    if (archived.tool !== 'pi' && !live.has(archived.path)) entries.push({ path: archived.path, tool: archived.tool });
  }

  return entries;
}

function collectSubagentContent(filePath: string): string {
  const dir = join(filePath.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return '';

  const parts: string[] = [];
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const lines = raw.trimEnd().split('\n');
        const msgs = getSessionMessages(lines);
        for (const m of msgs) {
          if (m.role === 'user') parts.push(m.text);
        }
      } catch {}
    }
  } catch {}
  return parts.join('\n');
}

/** Searchable subagent text folded into the parent session: Claude keeps sibling
 *  transcript files; OpenCode captures child text in its serialized snapshot. */
function collectSubagentText(filePath: string, tool: Tool, lines: string[]): string {
  if (tool === 'claude') return collectSubagentContent(filePath);
  if (tool === 'opencode') {
    for (const line of lines) {
      const record = asJsonObject(tryParse(line));
      if (record?.type === 'session' && typeof record.subagentText === 'string') return record.subagentText;
    }
  }
  return '';
}

// Refresh-scoped state threaded through indexFile: the vault manifest (mutated in
// place, saved once at the end) and a one-shot warn flag so a failing archive dir
// (disk full, EACCES) warns once and never blocks indexing.
interface RefreshCtx {
  manifest: Manifest;
  dir: string;
  warned: boolean;
  deferred: Set<string>;
}

// Archive one transcript into the vault, best-effort. Indexing must never be blocked
// by archiving, so a copy failure warns at most once per refresh and is swallowed.
function tryArchive(
  ctx: RefreshCtx,
  entry: { path: string; tool: Tool },
  parsed: { cwd: string; sessionId: string },
  stat: { mtime: number; size: number },
  snapshot?: string | Buffer,
): void {
  try {
    archiveFile(entry, parsed, stat, ctx.manifest, ctx.dir, snapshot);
  } catch (e) {
    if (!ctx.warned) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`sessions: vault archive failed (${msg}); continuing without archiving\n`);
      ctx.warned = true;
    }
  }
}

// Whether a session's LIVE source still exists (not the vault copy). A vault-only
// session (source gone) is served from the vault and must never be re-archived.
function liveSourcePresent(filePath: string, tool: Tool): boolean {
  if (tool === 'cursor' && cursorIdeLocation(filePath)) return cursorIdeSessionExists(filePath);
  if (tool === 'opencode') return opencodeStat(filePath) !== null;
  if (tool === 'antigravity' && filePath.endsWith('/transcript.jsonl')) {
    return (
      existsSync(filePath) ||
      existsSync(filePath.replace(/transcript\.jsonl$/, 'transcript_full.jsonl')) ||
      existsSync(antigravityDatabasePath(filePath)) ||
      antigravityGitVersion(filePath) !== null
    );
  }
  return existsSync(tool === 'codex' ? codexRolloutPath(filePath) : filePath);
}

// The negative-inventory path: drop any indexed rows for this file and record its
// mtime+size so an unchanged malformed/excluded transcript is not re-parsed forever.
function ignoreSession(
  db: Database,
  filePath: string,
  stat: { mtimeMs: number; size: number },
  hasExisting: boolean,
): void {
  if (hasExisting) {
    db.run('DELETE FROM sessions WHERE file_path = ?', [filePath]);
    db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
    db.run('DELETE FROM message_fts WHERE file_path = ?', [filePath]);
  }
  db.run('INSERT OR REPLACE INTO ignored_files (file_path, mtime, size) VALUES (?, ?, ?)', [
    filePath,
    stat.mtimeMs,
    stat.size,
  ]);
}

// Parse `lines` and write the session row + FTS rows, returning the session cwd on
// success or null when the lines are unusable (empty, no cwd, or an excluded worktree
// log). The caller owns ignored_files; this only writes on success.
function writeSessionRow(
  db: Database,
  filePath: string,
  tool: Tool,
  stat: { mtimeMs: number; size: number },
  lines: string[],
  hasExisting: boolean,
): { cwd: string; sessionId: string } | null {
  if (lines.length === 0) return null;

  const metadata = extractSessionMetadata(lines, tool);
  if (!metadata.cwd && tool !== 'cursor' && tool !== 'antigravity') return null;
  if (metadata.cwd.includes('.claude/worktrees') || metadata.cwd.includes('/.bare')) return null;

  const sourceId = metadata.sessionId ?? basename(filePath).replace(/\.jsonl(?:\.zst)?$/, '');
  // Claude child transcripts carry their parent's sessionId. Keep each child
  // independently addressable while retaining the original record unchanged.
  const sessionId =
    tool === 'claude' && /\/subagents\/[^/]+\.jsonl$/.test(filePath)
      ? `${sourceId}/subagents/${basename(filePath, '.jsonl')}`
      : sourceId;
  const messages = extractMessages(lines);
  const summary = summarizeMessages(messages);
  const subagentContent = collectSubagentText(filePath, tool, lines);

  const filesTouchedArr = extractFiles(lines, tool);
  const filesTouched = JSON.stringify(filesTouchedArr);
  const filesReadArr = extractFilesRead(lines, tool);
  const filesRead = JSON.stringify(filesReadArr);
  const commandsArr = extractCommands(lines, tool);
  const commands = JSON.stringify(commandsArr);
  const errors = extractErrors(lines, tool);
  const thinking = extractThinking(lines, tool);
  const headline = `${summary.firstPrompt}\n${metadata.customTitle}`;
  const pathsText = [...filesTouchedArr, ...filesReadArr].join('\n');
  const commandsText = commandsArr.join('\n');
  // Error text is searchable without counting it as a conversational turn.
  const contextText = errors.messages.join('\n');
  if (hasExisting) {
    db.run('DELETE FROM session_fts WHERE file_path = ?', [filePath]);
    db.run('DELETE FROM message_fts WHERE file_path = ?', [filePath]);
  }
  db.run('DELETE FROM ignored_files WHERE file_path = ?', [filePath]);
  db.run(
    `INSERT OR REPLACE INTO sessions (file_path, mtime, size, cwd, tool, session_id, date, created_at, started_at, ended_at, first_prompt, custom_title, message_count, files_touched, files_read, commands, errored, error_count, closing_user, closing_assistant, branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      filePath,
      stat.mtimeMs,
      stat.size,
      metadata.cwd,
      tool,
      sessionId,
      metadata.date,
      metadata.createdAt,
      metadata.startedAt,
      metadata.endedAt,
      summary.firstPrompt,
      metadata.customTitle,
      metadata.messageCount,
      filesTouched,
      filesRead,
      commands,
      errors.errored ? 1 : 0,
      errors.count,
      summary.closingUser,
      summary.closingAssistant,
      metadata.branch,
    ],
  );
  db.run(
    'INSERT INTO session_fts (file_path, headline, commands, paths, context_text, thinking) VALUES (?, ?, ?, ?, ?, ?)',
    [filePath, headline, commandsText, pathsText, contextText, thinking],
  );
  // Message rows: assistant turns always; user turns only when genuine - injected
  // skill bodies and tool results match everything and are exactly the noise the
  // trust fixes eliminated elsewhere. Their indices are still consumed by the
  // numbering (extractMessages counts them), they just get no FTS row. db.query()
  // caches the prepared statement, which matters at ~74 rows/session; the calls run
  // inside refreshIndex's per-batch transaction, never autocommit.
  const insertMessage = db.query('INSERT INTO message_fts (file_path, msg_index, role, text) VALUES (?, ?, ?, ?)');
  for (const m of messages) {
    if (m.role === 'user' && !m.genuine) continue;
    insertMessage.run(filePath, m.index, m.role, m.text);
  }
  // Subagent transcripts have no place in the parent's message numbering, so their
  // user text rides in a single sentinel row (msg_index -1): it keeps the session
  // findable by subagent-only terms but is excluded from messageHits.
  if (subagentContent) insertMessage.run(filePath, -1, 'user', subagentContent);
  return { cwd: metadata.cwd, sessionId };
}

function indexFile(db: Database, filePath: string, tool: Tool, ctx: RefreshCtx, force = false): boolean {
  // Deliberately re-stat rather than trusting refreshIndex's pre-lock snapshot: a
  // candidate may have waited behind another MCP process at BEGIN IMMEDIATE, and
  // this is where we observe that process's completed write (or a transcript
  // append) and skip the parse. A file that vanished during the wait - with no vault
  // copy either - stats as null and is left entirely alone; pruning is its owner.
  const stat = statSession(filePath, tool);
  if (!stat) return false;

  const existing = db
    .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM sessions WHERE file_path = ?')
    .get(filePath);
  if (!force && existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) return false;
  const ignored = db
    .query<{ mtime: number; size: number }, [string]>('SELECT mtime, size FROM ignored_files WHERE file_path = ?')
    .get(filePath);
  if (!force && ignored && ignored.mtime === stat.mtimeMs && ignored.size === stat.size) return false;

  let snapshot: Buffer | undefined;
  if (tool === 'claude' || tool === 'codex') {
    try {
      snapshot = tool === 'codex' ? readCodexRollout(filePath) : readFileSync(filePath);
    } catch {
      // Retain the established archive fallback when the live source cannot be read.
    }
  }
  const lines = snapshot ? snapshot.toString('utf8').trimEnd().split('\n') : readSessionLines(filePath, tool);
  const afterRead = statSession(filePath, tool);
  if (!afterRead || afterRead.mtimeMs !== stat.mtimeMs || afterRead.size !== stat.size) {
    ctx.deferred.add(filePath);
    return false;
  }
  const indexed = writeSessionRow(db, filePath, tool, stat, lines, !!existing);
  if (indexed) {
    // Archive only when the LIVE source is present. `stat` is the live stat in that
    // case (statSession tries the original path before the vault fallback).
    if (liveSourcePresent(filePath, tool)) {
      tryArchive(
        ctx,
        { path: filePath, tool },
        indexed,
        { mtime: stat.mtimeMs, size: stat.size },
        tool === 'opencode' || tool === 'cursor' || tool === 'antigravity' ? lines.join('\n') : snapshot,
      );
    }
    return true;
  }

  // The live file is unusable (empty/truncated/rotated by the vendor). If the vault
  // holds a parseable copy, index from that instead of ignoring the session - the
  // archived version is the durability promise.
  const entry = ctx.manifest[filePath];
  if (entry && existsSync(entry.vaultPath)) {
    let vaultLines: string[] = [];
    try {
      vaultLines = readFileSync(entry.vaultPath, 'utf-8').trimEnd().split('\n');
    } catch {}
    if (writeSessionRow(db, filePath, tool, stat, vaultLines, !!existing)) return true;
  }

  ignoreSession(db, filePath, stat, !!existing);
  return false;
}

async function runRefreshIndex(): Promise<RefreshResult> {
  const db = getDb();
  // The vault manifest, loaded once and saved once (saveManifest at the end):
  // archiveFile mutates this map in place during the batches, and a per-file save
  // could persist an archive whose index write later rolled back. One write follows.
  const ctx: RefreshCtx = {
    manifest: loadManifest(getArchiveDir()),
    dir: getArchiveDir(),
    warned: false,
    deferred: new Set(),
  };
  // De-duplicate at the boundary. It also makes the set/map work below line up
  // exactly with the total reported to callers.
  const files = [...new Map((await discoverFiles()).map((file) => [file.path, file])).values()];
  const filePaths = new Set(files.map((f) => f.path));

  // Fetch the current inventory once. The old path issued SELECT mtime,size once
  // per discovered file (~4,500 statements on the author's corpus) even when no
  // transcript had changed.
  const dbRows = db
    .query<{ file_path: string; mtime: number; size: number }, []>('SELECT file_path, mtime, size FROM sessions')
    .all();
  const indexedByPath = new Map(dbRows.map((row) => [row.file_path, row]));
  const ignoredRows = db
    .query<{ file_path: string; mtime: number; size: number }, []>('SELECT file_path, mtime, size FROM ignored_files')
    .all();
  const ignoredByPath = new Map(ignoredRows.map((row) => [row.file_path, row]));
  const inventoryPaths = new Set([...indexedByPath.keys(), ...ignoredByPath.keys()]);
  // A path backed by the vault is never pruned even when its live source is gone:
  // discoverFiles re-added it to `filePaths` (listArchived only returns entries whose
  // vault copy still exists), so the row stays and is served from the vault. Only
  // paths absent from BOTH the live sources and the vault are removed here.
  const removedPaths = [...inventoryPaths].filter((path) => !filePaths.has(path));
  if (removedPaths.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const path of removedPaths) {
        db.run('DELETE FROM sessions WHERE file_path = ?', [path]);
        db.run('DELETE FROM session_fts WHERE file_path = ?', [path]);
        db.run('DELETE FROM message_fts WHERE file_path = ?', [path]);
        db.run('DELETE FROM ignored_files WHERE file_path = ?', [path]);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (removedPaths.length > 100) {
      db.exec('VACUUM');
    }
  }

  // Stat source files before opening a write transaction, then transact only
  // candidates whose invalidation signal differs. indexFile re-checks after
  // BEGIN IMMEDIATE so a second MCP process that refreshed first makes this one
  // skip the expensive parse instead of duplicating it or racing a write lock.
  const candidates: FileEntry[] = [];
  for (const file of files) {
    const stat = statSession(file.path, file.tool);
    if (!stat) continue;
    const existing = indexedByPath.get(file.path);
    const ignored = ignoredByPath.get(file.path);
    const indexedMatches = existing && existing.mtime === stat.mtimeMs && existing.size === stat.size;
    const ignoredMatches = ignored && ignored.mtime === stat.mtimeMs && ignored.size === stat.size;
    if (!indexedMatches && !ignoredMatches) {
      candidates.push(file);
    }
  }

  let updated = 0;
  const BATCH = 200;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of batch) {
        if (indexFile(db, file.path, file.tool, ctx)) updated++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Backfill: archive every already-indexed session still missing from the manifest,
  // even though its index row is unchanged. The first refresh after upgrade preserves
  // the entire existing corpus this way. Vault-only sessions are already in the
  // manifest; a source that has since vanished has no live bytes to copy, so skip it.
  const indexedRows = db
    .query<{ file_path: string; cwd: string; session_id: string; tool: string; mtime: number; size: number }, []>(
      'SELECT file_path, cwd, session_id, tool, mtime, size FROM sessions',
    )
    .all();
  for (const row of indexedRows) {
    const archived = ctx.manifest[row.file_path];
    if (archived) {
      archived.sessionId = row.session_id;
      archived.cwd = row.cwd;
      continue;
    }
    // SAFETY: the tool column is written by the index from Tool values only.
    const tool = row.tool as Tool;
    if (ctx.deferred.has(row.file_path) || !liveSourcePresent(row.file_path, tool)) continue;
    // Reuse import so source data and index metadata come from the same capture.
    db.transaction(() => {
      if (indexFile(db, row.file_path, tool, ctx, true)) updated++;
    }).immediate();
  }

  // One atomic manifest write for the whole refresh (see the ctx comment above).
  saveManifest(ctx.dir, ctx.manifest);
  importDocuments(db, process.env.SESSIONS_NATIVE_HOME || getHome(), join(ctx.dir, 'native-documents'));

  return ctx.warned ? { total: files.length, updated, archiveWarning: true } : { total: files.length, updated };
}

/**
 * Force a source scan, coalescing concurrent callers in this process onto one
 * pass. Queries use ensureIndexFresh; the daemon calls this operation directly
 * for each scheduled import.
 *
 * Coalescing weakens "scan now" for a caller that arrives mid-flight: it joins a
 * pass whose file list was snapshotted before the caller's own write, so it may
 * not observe that write. Anything needing a guaranteed post-write scan must run
 * after the in-flight promise settles, not alongside it.
 */
export async function refreshIndex(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;

  const promise = (async () => {
    const release = await acquireRefreshLock(getArchiveDir());
    try {
      return await runRefreshIndex();
    } finally {
      release();
    }
  })();
  _refreshPromise = promise;
  try {
    const result = await promise;
    _lastRefreshAt = Date.now();
    _lastRefreshResult = result;
    return result;
  } finally {
    if (_refreshPromise === promise) _refreshPromise = null;
  }
}

function refreshIntervalMs(): number {
  const configured = Number(process.env.SESSIONS_REFRESH_INTERVAL_MS ?? 5_000);
  return Number.isFinite(configured) ? Math.max(0, configured) : 5_000;
}

export async function ensureIndexFresh(): Promise<RefreshResult> {
  if (_refreshPromise) return _refreshPromise;
  if (_lastRefreshAt > 0 && Date.now() - _lastRefreshAt < refreshIntervalMs()) return _lastRefreshResult;
  return refreshIndex();
}
