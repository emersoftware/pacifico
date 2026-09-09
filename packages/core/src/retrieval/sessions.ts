import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getDb } from '../storage/index';
import { ensureIndexFresh } from '../ingestion/sessions';
import type {
  Tool,
  SessionResult,
  ActivityDigest,
  DigestProjectGroup,
  DigestDay,
  DigestSessionDetail,
  SessionMetrics,
  ContextPrimer,
  ContextSession,
  ContextHeadline,
  MessageHit,
} from '../types';
import { getSessionMessages } from '../parser';
import { jsonStrings } from '../extract-util';
import { readSessionLines } from '../session-io';
import { MAX_FILES as MAX_PRIMER_FILES } from '../search-format';
import { type RepoInfo, globPrefix, branchLabel, cwdUnder } from '../repo';
import { isTrivia, blendedScore, type ScorableSession } from '../significance';

// Read-only index access for stats consumers (`pacifico wrapped`). Refreshes
// first so queries see current transcripts, then hands back the shared handle.
// Callers must treat the connection as read-only - all writes stay in this file.
export async function getIndexDb(): Promise<Database> {
  await ensureIndexFresh();
  return getDb();
}

/**
 * A row count safe to hand to a `LIMIT ?` placeholder (or a `.slice()` that stands in for
 * one): at least 1, an integer, never NaN.
 *
 * SQLite reads a NEGATIVE limit as no limit at all, so `-1` - the value most likely to be
 * passed meaning "none" - selects every matching row instead. A fractional limit is no
 * better defined. Callers at the MCP boundary are bounded by their input schemas
 * (src/mcp.ts), and this is the floor under every other caller, including the next one.
 * `grepSessions` keeps its own guard because 0 is meaningful there: it returns the
 * uncapped totals with no snippets.
 */
function rowLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

// Ranking knobs - the eval fixture's tuning surface (src/eval/, docs/TESTING.md).
// These move ONLY against the golden fixture, in coarse steps: change a value,
// run `bun run eval`, and keep the change only if the gate stays green because a
// real miss got fixed. The fixture is versioned with the values; grow it (log
// real misses as new goldens) before giving the knobs another pass.
//
// bm25 column weights map to session_fts columns in declaration order:
// file_path, headline, commands, paths, context_text, thinking. Headline,
// commands, and paths carry the concrete cues people re-find sessions by;
// verbose thinking adds recall without dominating (message text ranks via
// message_fts below).
export const SESSION_FTS_COLUMN_WEIGHTS = [0.0, 10.0, 6.0, 5.0, 2.0, 0.5] as const;
// message_fts: file_path, msg_index, role, text - only the text column ranks.
export const MESSAGE_FTS_COLUMN_WEIGHTS = [0.0, 0.0, 0.0, 1.0] as const;
// bm25 can't weight by row, so user-turn ranks are boosted in JS instead (bm25
// is more-negative-is-better; multiplying a negative rank improves it).
export const USER_HIT_BOOST = 1.5;

export interface SearchOptions {
  after?: string;
  before?: string;
  tool?: Tool | '';
  project?: string;
  errored?: boolean;
  /** Substring match against files_touched OR files_read; multiple values AND-compose.
   *  Empty array = absent. With no query, filtered results order newest-first (created_at). */
  files?: string[];
  limit?: number;
}

export async function searchSessions(query: string, opts: SearchOptions = {}): Promise<SessionResult[]> {
  const db = getDb();
  await ensureIndexFresh();

  const toolFilter = opts.tool ?? '';
  const project = opts.project ?? '';
  const limit = rowLimit(opts.limit, 50);

  interface SessionRow {
    file_path: string;
    cwd: string;
    tool: string;
    session_id: string;
    date: string;
    created_at: string;
    first_prompt: string;
    custom_title: string;
    message_count: number;
    files_touched: string;
    files_read: string;
    commands: string;
    errored: number;
    snippet: string | null;
  }

  let rows: SessionRow[];
  const hitsByPath = new Map<string, MessageHit[]>();

  // Split the free-text query into individual quoted terms joined with OR. OR recall
  // (any term may match) paired with bm25() ranking surfaces the sessions matching the
  // most - and rarest - terms first, instead of the old strict-AND that returned
  // nothing unless every word was present. This matters most for the LLM/MCP caller,
  // which issues long natural-language queries. Quoting each term keeps FTS5 operators
  // in user input literal. An all-whitespace/quotes query yields no terms → recent list.
  const ftsTerms = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`);
  const ftsQuery = ftsTerms.join(' OR ');

  // Both branches filter the sessions table directly with the same conditions.
  const conditions: string[] = [];
  const condParams: (string | number)[] = [];
  if (toolFilter) {
    conditions.push('tool = ?');
    condParams.push(toolFilter);
  }
  if (project) {
    // Boundary-aware: the project root itself or a descendant, never a sibling
    // sharing a prefix (e.g. `dotfiles-v2` must not match `dotfiles`).
    conditions.push('(cwd = ? OR cwd GLOB ?)');
    condParams.push(project, globPrefix(project));
  }
  if (opts.errored) conditions.push('errored = 1');
  if (opts.after) {
    conditions.push('date >= ?');
    condParams.push(opts.after);
  }
  if (opts.before) {
    conditions.push('date <= ?');
    condParams.push(opts.before);
  }
  // Files filter: substring match over the JSON-array text columns - callers pass a
  // path suffix or full path. Deliberately imprecise (a short fragment can match an
  // unrelated longer path); precision comes from passing longer suffixes. LIKE
  // metacharacters are escaped so paths with `_` (common) match literally.
  const files = (opts.files ?? []).filter((f) => f.length > 0); // blank entries = absent, like an empty array
  for (const f of files) {
    conditions.push("(files_touched LIKE '%' || ? || '%' ESCAPE '\\' OR files_read LIKE '%' || ? || '%' ESCAPE '\\')");
    const escaped = f.replace(/[\\%_]/g, (c) => `\\${c}`);
    condParams.push(escaped, escaped);
  }

  if (ftsQuery) {
    // Session-level results merge two hit sources: the slimmed session_fts (metadata
    // match) and message_fts aggregated by file_path (content match). Fetch both,
    // join in JS on file_path, combine ranks, sort, slice to limit.

    const SESSION_RANK = `bm25(session_fts, ${SESSION_FTS_COLUMN_WEIGHTS.join(', ')})`;
    interface SessionHitRow {
      file_path: string;
      srank: number;
      ssnippet: string | null;
    }
    const sessionHits = db
      .query<SessionHitRow, [string]>(
        `
      SELECT file_path, ${SESSION_RANK} AS srank, snippet(session_fts, -1, '', '', '…', 32) AS ssnippet
      FROM session_fts WHERE session_fts MATCH ?
    `,
      )
      .all(ftsQuery);

    interface MessageHitRow {
      file_path: string;
      msg_index: number;
      role: string;
      mrank: number;
      msnippet: string;
    }
    const messageRows = db
      .query<MessageHitRow, [string]>(
        `
      SELECT file_path, msg_index, role,
             bm25(message_fts, ${MESSAGE_FTS_COLUMN_WEIGHTS.join(', ')}) AS mrank,
             snippet(message_fts, 3, '', '', '…', 32) AS msnippet
      FROM message_fts WHERE message_fts MATCH ?
    `,
      )
      .all(ftsQuery);

    // Role weighting replaces the old user_content 3.0 / assistant_content 2.0
    // column weights (see USER_HIT_BOOST above).
    interface MessageAgg {
      best: number; // best (most negative) weighted rank across the session's hits
      hits: { hit: MessageHit; rank: number }[];
    }
    const msgAgg = new Map<string, MessageAgg>();
    for (const m of messageRows) {
      const rank = m.role === 'user' ? m.mrank * USER_HIT_BOOST : m.mrank;
      let agg = msgAgg.get(m.file_path);
      if (!agg) {
        agg = { best: 0, hits: [] };
        msgAgg.set(m.file_path, agg);
      }
      agg.best = Math.min(agg.best, rank);
      // Sentinel rows (msg_index -1: subagent text) rank the session but are not
      // addressable messages, so they never become visible hits.
      if (m.msg_index >= 0) {
        // SAFETY: the role column is written by the index from 'user' | 'assistant' values only.
        agg.hits.push({ hit: { index: m.msg_index, role: m.role as 'user' | 'assistant', snippet: m.msnippet }, rank });
      }
    }

    const sessionHitByPath = new Map(sessionHits.map((s) => [s.file_path, s]));
    const candidatePaths = [...new Set([...sessionHitByPath.keys(), ...msgAgg.keys()])];

    // Fetch metadata (applying the filters) for every candidate, chunked to stay
    // well under SQLite's bound-parameter limit however many sessions match.
    const metaByPath = new Map<string, SessionRow>();
    const CHUNK = 400;
    const extra = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
    for (let i = 0; i < candidatePaths.length; i += CHUNK) {
      const chunk = candidatePaths.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const metaRows = db
        .query<SessionRow, any[]>(
          `
        SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
               custom_title, message_count, files_touched, files_read, commands, errored,
               NULL as snippet
        FROM sessions WHERE file_path IN (${placeholders}) ${extra}
      `,
        )
        .all(...chunk, ...condParams);
      for (const r of metaRows) metaByPath.set(r.file_path, r);
    }

    // finalRank = sessionRank + bestMessageRank: a missing side contributes 0, and
    // matching both sources compounds (both are negative). The display snippet
    // prefers the best message hit (localized - strictly better than a whole-session
    // snippet) and falls back to the session-side snippet for metadata-only matches.
    const merged = [...metaByPath.values()].map((meta) => {
      const s = sessionHitByPath.get(meta.file_path);
      const agg = msgAgg.get(meta.file_path);
      const hits = (agg?.hits ?? [])
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 3)
        .map((h) => h.hit);
      return {
        meta,
        hits,
        snippet: hits[0]?.snippet ?? s?.ssnippet ?? null,
        finalRank: (s?.srank ?? 0) + (agg?.best ?? 0),
      };
    });
    merged.sort((a, b) => a.finalRank - b.finalRank || b.meta.date.localeCompare(a.meta.date));

    const top = merged.slice(0, limit);
    rows = top.map((m) => ({ ...m.meta, snippet: m.snippet }));
    for (const m of top) hitsByPath.set(m.meta.file_path, m.hits);
  } else {
    const params: (string | number)[] = [...condParams, limit];
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    // A files filter without a query is the "what happened to this file lately"
    // shape: newest-first by creation time, not last-activity date.
    const orderBy = files.length > 0 ? 'created_at DESC' : 'date DESC';
    rows = db
      .query<SessionRow, any[]>(
        `
      SELECT file_path, cwd, tool, session_id, date, created_at, first_prompt,
             custom_title, message_count, files_touched, files_read, commands, errored,
             NULL as snippet
      FROM sessions ${where}
      ORDER BY ${orderBy} LIMIT ?
    `,
      )
      .all(...params);
  }

  return rows.map((r) => ({
    date: r.date,
    createdAt: r.created_at,
    cwd: r.cwd,
    // SAFETY: the tool column is written by the index from Tool values only.
    tool: r.tool as Tool,
    sessionId: r.session_id,
    displayText: r.snippet ?? (r.custom_title || r.first_prompt),
    customTitle: r.custom_title,
    messageCount: r.message_count,
    filePath: r.file_path,
    exists: existsSync(r.cwd),
    // `files` is the union of edited + read files so it answers "what files did this
    // session involve" (a Read-only target is still surfaced).
    files: [...new Set([...parseFiles(r.files_touched), ...parseFiles(r.files_read)])],
    commands: parseFiles(r.commands),
    errored: r.errored === 1,
    messageHits: hitsByPath.get(r.file_path) ?? [],
  }));
}

export interface GrepOptions {
  /** Treat the pattern as a JS regular expression. Default false = literal substring. */
  regex?: boolean;
  /** Case-insensitive match (default true). */
  ignoreCase?: boolean;
  /** Restrict to one message role. */
  role?: 'user' | 'assistant';
  tool?: Tool | '';
  project?: string;
  /** Session date (YYYY-MM-DD) lower/upper bounds, inclusive. */
  after?: string;
  before?: string;
  /** Max hit snippets to return (default 50). totalHits still counts every match. */
  limit?: number;
  /** Snippet radius in chars around the match (default 60). */
  contextChars?: number;
}

export interface GrepHit {
  tool: Tool;
  project: string;
  sessionId: string;
  filePath: string;
  date: string;
  role: 'user' | 'assistant';
  /** Feeds get_session_messages(offset) directly - same numbering as message_fts. */
  msgIndex: number;
  snippet: string;
}

export interface GrepResult {
  /** Messages containing at least one match (across the whole corpus, uncapped). */
  totalHits: number;
  /** Distinct sessions with a match. */
  totalSessions: number;
  returnedHits: number;
  /** True when totalHits exceeds the returned snippets (some hits not shown). */
  truncated: boolean;
  hits: GrepHit[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exhaustive literal-or-regex match over every indexed message (genuine user turns +
 * assistant text), unlike searchSessions which is ranked and top-k. Each hit carries
 * filePath + msgIndex so it feeds get_session_messages(offset) with no extra lookup.
 * Streams message rows so memory stays O(limit) however large the corpus. Matches the
 * same text corpus as search (message_fts): assistant tool-call inputs are not indexed,
 * so a command string won't be found here - grep prose, navigate to the turn, then read
 * it with include_tools.
 */
export async function grepSessions(pattern: string, opts: GrepOptions = {}): Promise<GrepResult> {
  if (!pattern) throw new Error('Empty pattern: pass a non-empty string to search for.');

  const db = getDb();
  await ensureIndexFresh();

  const ignoreCase = opts.ignoreCase ?? true;
  // Guard against fractional/negative limits so `hits.length < limit` behaves as a
  // whole-number "max snippets" cap; 0 is allowed (count-only, snippets suppressed).
  const limit = Math.max(0, Math.floor(opts.limit ?? 50));
  const radius = Math.max(0, Math.floor(opts.contextChars ?? 60));

  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? pattern : escapeRegExp(pattern), ignoreCase ? 'i' : '');
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  const conditions: string[] = ['m.msg_index >= 0']; // exclude the subagent sentinel (-1)
  const params: (string | number)[] = [];
  if (opts.role) {
    conditions.push('m.role = ?');
    params.push(opts.role);
  }
  if (opts.tool) {
    conditions.push('s.tool = ?');
    params.push(opts.tool);
  }
  if (opts.project) {
    conditions.push('(s.cwd = ? OR s.cwd GLOB ?)');
    params.push(opts.project, globPrefix(opts.project));
  }
  if (opts.after) {
    conditions.push('s.date >= ?');
    params.push(opts.after);
  }
  if (opts.before) {
    conditions.push('s.date <= ?');
    params.push(opts.before);
  }
  // Literal mode: a LIKE filter cuts rows before the JS regex confirms each match - a huge
  // win for rare terms. But SQLite LIKE folds case for ASCII only, while the JS `/i` regex
  // folds Unicode too, so for a case-insensitive pattern containing a non-ASCII letter the
  // LIKE is NOT a superset (`%café%` would drop a stored "CAFÉ" the regex would match).
  // Apply the prefilter only when it's provably a superset: case-sensitive, or ASCII-only
  // pattern. Otherwise stream the full candidate set and let the regex alone decide (as
  // regex mode already does). Regex mode is never prefiltered.
  const asciiOnly = ![...pattern].some((ch) => ch.codePointAt(0)! > 0x7f);
  if (!opts.regex && (!ignoreCase || asciiOnly)) {
    conditions.push("m.text LIKE '%' || ? || '%' ESCAPE '\\'");
    params.push(pattern.replace(/[\\%_]/g, (c) => `\\${c}`));
  }

  interface Row {
    filePath: string;
    msgIndex: number;
    role: string;
    text: string;
    tool: string;
    cwd: string;
    date: string;
    sessionId: string;
  }
  const stmt = db.query<Row, any[]>(`
    SELECT m.file_path AS filePath, m.msg_index AS msgIndex, m.role AS role, m.text AS text,
           s.tool AS tool, s.cwd AS cwd, s.date AS date, s.session_id AS sessionId
    FROM message_fts m JOIN sessions s ON s.file_path = m.file_path
    WHERE ${conditions.join(' AND ')}
  `);

  let totalHits = 0;
  const sessions = new Set<string>();
  const hits: GrepHit[] = [];
  for (const row of stmt.iterate(...params)) {
    const m = re.exec(row.text); // non-global regex → always scans from position 0
    if (!m) continue;
    totalHits++;
    sessions.add(row.filePath);
    if (hits.length < limit) {
      const pos = m.index;
      const start = Math.max(0, pos - radius);
      const end = Math.min(row.text.length, pos + m[0].length + radius);
      let snippet = row.text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < row.text.length) snippet = snippet + '…';
      hits.push({
        // SAFETY: tool/role columns are written by the index from Tool and 'user'|'assistant' values only.
        tool: row.tool as Tool,
        project: row.cwd,
        sessionId: row.sessionId,
        filePath: row.filePath,
        date: row.date,
        // SAFETY: same index-written contract as tool above.
        role: row.role as 'user' | 'assistant',
        msgIndex: row.msgIndex,
        snippet,
      });
    }
  }

  return {
    totalHits,
    totalSessions: sessions.size,
    returnedHits: hits.length,
    truncated: totalHits > hits.length,
    hits,
  };
}

/**
 * Resolve a session id to its indexed JSONL file path. Refreshes the index
 * first (same as searchSessions) so recently created sessions resolve too.
 * Collisions - the same id indexed from multiple files - pick the newest by
 * mtime. Returns null when the id is unknown.
 */
export async function resolveSessionFile(sessionId: string): Promise<string | null> {
  const db = getDb();
  await ensureIndexFresh();
  const row = db
    .query<{ file_path: string }, [string]>(
      'SELECT file_path FROM sessions WHERE session_id = ? ORDER BY mtime DESC LIMIT 1',
    )
    .get(sessionId);
  return row?.file_path ?? null;
}

interface DateRangeRow {
  file_path: string;
  cwd: string;
  tool: string;
  session_id: string;
  date: string;
  created_at: string;
  started_at: string;
  first_prompt: string;
  custom_title: string;
  message_count: number;
}

/** The machine's IANA zone. Resolved per call: `Date#getHours` reads a zone V8 caches on
 *  first use, which makes the process default untestable once anything has read a clock. */
function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const hourFmtCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The two-digit hour of an ISO timestamp in `tz`, or null when there is nothing to read.
 *
 * Formats against an explicit zone rather than calling `getHours()`, so the conversion
 * depends on an argument instead of ambient process state. Deliberately not
 * src/report/parsers/util.ts's localHour: that file is vendored verbatim from upstream
 * and the report subtree stays self-contained. This one keys the activeHours histogram,
 * so it returns the zero-padded string that map is indexed by.
 */
function hourIn(iso: string, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let fmt = hourFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
    hourFmtCache.set(tz, fmt);
  }
  const h = fmt.formatToParts(d).find((p) => p.type === 'hour')?.value;
  if (h === undefined) return null;
  // en-US renders midnight as '24' in some ICU builds; the histogram is 00-23.
  return String(Number(h) % 24).padStart(2, '0');
}

function queryDateRange(
  db: Database,
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
): DateRangeRow[] {
  const conditions: string[] = ['created_at >= ?', 'created_at <= ?'];
  const params: (string | number)[] = [startDate, endDate];

  if (toolFilter) {
    conditions.push('tool = ?');
    params.push(toolFilter);
  }
  if (project) {
    conditions.push('(cwd = ? OR cwd GLOB ?)');
    params.push(project, globPrefix(project));
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  return db
    .query<DateRangeRow, any[]>(
      `SELECT file_path, cwd, tool, session_id, date, created_at, started_at, first_prompt, custom_title, message_count
       FROM sessions ${where}
       ORDER BY created_at ASC, date ASC`,
    )
    .all(...params);
}

const MAX_TOPICS = 10;
const MAX_FILEPATHS = 5;
const MAX_SESSIONS_DETAIL = 10;
const MAX_USER_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 500;

interface PendingGroup {
  group: DigestProjectGroup;
  rows: DateRangeRow[];
}

function readUserMessages(filePath: string, mode: 'full' | 'highlights'): string[] {
  const lines = readSessionLines(filePath);
  const msgs = getSessionMessages(lines).filter((m) => m.role === 'user');
  if (msgs.length === 0) return [];

  const cap = (t: string, len: number) => (t.length > len ? t.slice(0, len) + '…' : t);

  if (mode === 'highlights') {
    const result = [cap(msgs[0]!.text, 300)];
    if (msgs.length > 1) result.push(cap(msgs[msgs.length - 1]!.text, 300));
    return result;
  }

  return msgs.slice(0, MAX_USER_MESSAGES).map((m) => cap(m.text, MAX_MESSAGE_LENGTH));
}

export type DigestDetail = 'compact' | 'highlights' | 'full';

export async function getActivityDigest(
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
  detail: DigestDetail = 'compact',
): Promise<ActivityDigest> {
  const db = getDb();
  await ensureIndexFresh();

  const rows = queryDateRange(db, startDate, endDate, toolFilter, project);

  const toolCounts: Record<string, number> = {};
  const projectSet = new Set<string>();
  let totalMessages = 0;

  const dayProjectMap = new Map<string, Map<string, PendingGroup>>();

  for (const r of rows) {
    toolCounts[r.tool] = (toolCounts[r.tool] ?? 0) + 1;
    projectSet.add(r.cwd);
    totalMessages += r.message_count;

    const day = r.created_at;
    if (!dayProjectMap.has(day)) dayProjectMap.set(day, new Map());
    const projectMap = dayProjectMap.get(day)!;

    if (!projectMap.has(r.cwd)) {
      projectMap.set(r.cwd, {
        group: {
          project: r.cwd,
          sessions: 0,
          totalMessages: 0,
          tools: [],
          topics: [],
          filePaths: [],
        },
        rows: [],
      });
    }

    const pending = projectMap.get(r.cwd)!;
    const g = pending.group;
    g.sessions++;
    g.totalMessages += r.message_count;
    if (!g.tools.includes(r.tool)) g.tools.push(r.tool);
    const topic = r.custom_title || r.first_prompt;
    if (topic) g.topics.push(topic);
    g.filePaths.push(r.file_path);
    pending.rows.push(r);
  }

  const days: DigestDay[] = [];
  for (const [date, projectMap] of dayProjectMap) {
    const projects = [...projectMap.values()].map(({ group: g, rows: sessionRows }) => {
      const result: DigestProjectGroup = {
        ...g,
        topics: [...new Set(g.topics)].slice(0, MAX_TOPICS),
        filePaths: g.filePaths.slice(-MAX_FILEPATHS),
      };

      if (detail === 'full' || detail === 'highlights') {
        const sorted = [...sessionRows].sort((a, b) => b.message_count - a.message_count);
        const minMessages = detail === 'highlights' ? 3 : 0;
        const candidates = sorted.filter((r) => r.message_count > minMessages);
        result.sessionDetails = candidates.slice(0, MAX_SESSIONS_DETAIL).map((r): DigestSessionDetail => ({
          sessionId: r.session_id,
          tool: r.tool,
          title: r.custom_title || r.first_prompt,
          messageCount: r.message_count,
          filePath: r.file_path,
          userMessages: readUserMessages(r.file_path, detail),
        }));
      }

      return result;
    });
    const daySessions = projects.reduce((sum, p) => sum + p.sessions, 0);
    days.push({ date, sessions: daySessions, projects });
  }

  return {
    period: { start: startDate, end: endDate },
    totalSessions: rows.length,
    totalMessages,
    tools: toolCounts,
    projects: [...projectSet],
    days,
  };
}

export async function getSessionMetrics(
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
  /** IANA zone for the active-hours histogram. Defaults to the machine's. */
  tz: string = systemTz(),
): Promise<SessionMetrics> {
  const db = getDb();
  await ensureIndexFresh();

  const rows = queryDateRange(db, startDate, endDate, toolFilter, project);

  const toolBreakdown: Record<string, number> = {};
  const projectMap = new Map<string, { sessions: number; messages: number }>();
  const dailyMap = new Map<string, { sessions: number; messages: number }>();
  const activeHours: Record<string, number> = {};
  let totalMessages = 0;

  for (const r of rows) {
    toolBreakdown[r.tool] = (toolBreakdown[r.tool] ?? 0) + 1;
    totalMessages += r.message_count;

    const pm = projectMap.get(r.cwd) ?? { sessions: 0, messages: 0 };
    pm.sessions++;
    pm.messages += r.message_count;
    projectMap.set(r.cwd, pm);

    const day = r.created_at;
    const dm = dailyMap.get(day) ?? { sessions: 0, messages: 0 };
    dm.sessions++;
    dm.messages += r.message_count;
    dailyMap.set(day, dm);

    // Local, not UTC. Transcript timestamps are Z-normalized, and slicing the hour out
    // of the ISO string read it as wall-clock - shifting the whole histogram by the
    // machine's offset, so a US-Central user's 9am showed up as 2pm or 3pm.
    const hour = hourIn(r.started_at, tz);
    if (hour !== null) activeHours[hour] = (activeHours[hour] ?? 0) + 1;
  }

  const projectBreakdown = [...projectMap.entries()]
    .map(([p, v]) => ({ project: p, sessions: v.sessions, messages: v.messages }))
    .sort((a, b) => b.sessions - a.sessions);

  const dailyActivity = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, sessions: v.sessions, messages: v.messages }))
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  return {
    period: { start: startDate, end: endDate },
    totalSessions: rows.length,
    totalMessages,
    toolBreakdown,
    projectBreakdown,
    dailyActivity,
    activeHours,
  };
}

export interface ContextOptions {
  limit?: number; // recent-tier size (default 10)
  days?: number; // optional window (last N days)
  tool?: Tool | ''; // optional tool filter
  worktreeOnly?: boolean; // restrict to current worktree (default false → aggregate)
  headlineCap?: number; // older-tier cap (default 40)
}

interface ContextRow {
  cwd: string;
  tool: string;
  session_id: string;
  date: string;
  created_at: string;
  first_prompt: string;
  custom_title: string;
  message_count: number;
  files_touched: string;
  closing_user: string;
  closing_assistant: string;
  branch: string;
}

/**
 * Drop every root that another root already contains, so a scope predicate carries one
 * pair of parameters per genuinely distinct tree.
 *
 * Sorted first, which is what makes one pass correct: an ancestor is a strict prefix of its
 * descendants, and a prefix always sorts before the longer string - so by the time a root is
 * considered, any root that contains it has already been kept.
 */
function coveringRoots(roots: string[]): string[] {
  const kept: string[] = [];
  for (const root of [...new Set(roots.filter(Boolean))].sort()) {
    if (!kept.some((parent) => cwdUnder(root, parent))) kept.push(root);
  }
  return kept;
}

/**
 * Every directory a repo's sessions can have been recorded in.
 *
 * `repo.container` alone is NOT the repo, and this is the bug the container abstraction
 * hides. In the bare layout every worktree lives under the container, so one prefix covers
 * all of them - but `git worktree add ../feature-x` on a normal repo puts the new worktree
 * BESIDE the main one, and `container` falls back to `--show-toplevel`, which resolves to
 * whichever worktree the caller happens to be standing in (src/repo.ts). Container-and-
 * descendants therefore returns only the current worktree's sessions from either side,
 * while the surfaces built on it advertise aggregation.
 *
 * The additional roots are the live worktree paths `resolveRepo` already parsed out of
 * `git worktree list --porcelain` - an enumeration, not a path heuristic. That is precisely
 * what keeps a `…-v2` SIBLING out: it shares a prefix with the container but git does not
 * list it as a worktree of this repo, and only a prefix rule could ever have matched it.
 */
function repoRoots(repo: RepoInfo, worktreeOnly = false): string[] {
  if (worktreeOnly) return [repo.currentWorktree];
  return coveringRoots([repo.container, ...repo.branches.keys()]);
}

/** A boundary-aware `cwd` predicate over several roots. Parenthesized as a whole: OR'd
 *  alternatives inside a clause that gets AND'd with tool/date filters must not leak. */
interface ScopeClause {
  clause: string;
  params: string[];
}

function repoScopeClause(roots: string[]): ScopeClause {
  // No roots means no repo, which must select nothing rather than everything.
  if (roots.length === 0) return { clause: '(1 = 0)', params: [] };
  return {
    clause: '(' + roots.map(() => '(cwd = ? OR cwd GLOB ?)').join(' OR ') + ')',
    params: roots.flatMap((root) => [root, globPrefix(root)]),
  };
}

function parseFiles(json: string): string[] {
  try {
    // The files_touched column is written by the index from string[]; the JSON
    // read-back still validates because a hand-edited row could carry anything.
    return jsonStrings(JSON.parse(json));
  } catch {
    return [];
  }
}

/**
 * Repo-scoped, two-tier, worktree-aggregated context primer assembled entirely
 * from indexed columns + the RepoInfo branch map. Reads zero session source
 * files (everything comes from the `sessions` table and the one `git worktree
 * list` call already made in resolveRepo).
 */
export async function getContextPrimer(repo: RepoInfo, opts: ContextOptions): Promise<ContextPrimer> {
  const db = getDb();
  await ensureIndexFresh();

  const limit = rowLimit(opts.limit, 10);
  const headlineCap = rowLimit(opts.headlineCap, 40);
  const toolFilter = opts.tool ?? '';

  // Boundary-aware scope: every root of this repo (or just the current worktree) and their
  // descendants - captures linked worktrees wherever git put them, while excluding a
  // same-prefix `…-v2` sibling that is not a worktree of this repo at all.
  const scope = repoScopeClause(repoRoots(repo, opts.worktreeOnly));
  const conditions: string[] = [scope.clause];
  const params: (string | number)[] = [...scope.params];

  if (toolFilter) {
    conditions.push('tool = ?');
    params.push(toolFilter);
  }
  if (opts.days && opts.days > 0) {
    const cutoff = new Date(Date.now() - opts.days * 86_400_000).toISOString().slice(0, 10);
    conditions.push('created_at >= ?');
    params.push(cutoff);
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const rows = db
    .query<ContextRow, any[]>(
      `SELECT cwd, tool, session_id, date, created_at, first_prompt, custom_title, message_count,
              files_touched, closing_user, closing_assistant, branch
       FROM sessions ${where}
       ORDER BY created_at DESC, date DESC`,
    )
    .all(...params);

  const repoLabel = basename(repo.container);
  if (rows.length === 0) {
    return { repoLabel, toolFilter, recent: [], headlines: [], isEmpty: true };
  }

  // Rank the detail tier by recency-weighted significance instead of raw recency,
  // keeping trivial sessions out of it. All inputs are already-selected columns.
  const now = Date.now();
  const scored = rows.map((r) => {
    const s: ScorableSession = {
      messageCount: r.message_count,
      filesTouchedCount: parseFiles(r.files_touched).length,
      closingText: `${r.closing_user} ${r.closing_assistant}`,
      createdAt: r.created_at !== '?' ? r.created_at : r.date,
    };
    return { row: r, trivia: isTrivia(s), score: blendedScore(s, now) };
  });

  const byScore = (a: { score: number }, b: { score: number }): number => b.score - a.score;
  const substantive = scored.filter((x) => !x.trivia).sort(byScore);
  // Fallback: an all-trivial repo still shows something rather than an empty
  // detail tier - trivia only loses its slot when real work competes for it.
  const pool = substantive.length > 0 ? substantive : [...scored].sort(byScore);
  const recentRows = pool.slice(0, limit).map((x) => x.row);

  // Headlines = every row not promoted to the detail tier, kept in the SQL
  // recency order (created_at DESC), capped. Demoted trivia lands here.
  const detailSet = new Set(recentRows);
  const headlineRows = rows.filter((r) => !detailSet.has(r)).slice(0, headlineCap);

  const recent: ContextSession[] = recentRows.map((r) => {
    // One parse per row: files_touched is a JSON column and the detail tier holds up to
    // `limit` rows, so parsing it twice (once to cap, once to count) doubles the work on
    // the primer's hot path for nothing.
    const files = parseFiles(r.files_touched);
    return {
      sessionId: r.session_id,
      // SAFETY: the tool column is written by the index from Tool values only.
      tool: r.tool as Tool,
      branch: r.branch || branchLabel(r.cwd, repo.branches),
      date: r.date,
      messageCount: r.message_count,
      intent: r.custom_title || r.first_prompt,
      // Same cap as the search projection: 10 sessions × an unbounded file list was the
      // primer's version of the search payload problem.
      files: files.slice(0, MAX_PRIMER_FILES),
      fileCount: files.length,
      opening: r.first_prompt,
      closing: { user: r.closing_user, assistant: r.closing_assistant },
    };
  });

  const headlines: ContextHeadline[] = headlineRows.map((r) => ({
    date: r.date,
    // SAFETY: the tool column is written by the index from Tool values only.
    tool: r.tool as Tool,
    branch: r.branch || branchLabel(r.cwd, repo.branches),
    intent: r.custom_title || r.first_prompt,
  }));

  return { repoLabel, toolFilter, recent, headlines, isEmpty: false };
}

/** Fallback row cap when a caller hands `recentSessionsForRepo` an unusable limit. The MCP
 *  surface passes MAX_LISTED_RESOURCES (src/mcp.ts); this is only the floor under nonsense. */
const MAX_REPO_SESSION_ROWS = 50;

/** One indexed session projected to just what an MCP `resources/list` entry needs. */
export interface RepoSessionRow {
  session_id: string;
  tool: string;
  date: string;
  /** MAX(created_at) of the id's rows - the ordering key, not display data. */
  created_at: string;
  first_prompt: string;
  custom_title: string;
}

/**
 * The newest `limit` sessions in a repo, plus the untruncated total.
 *
 * Same boundary-aware scope as getContextPrimer - every root of the repo plus their
 * descendants, so linked worktrees aggregate while a `…-v2` sibling stays out. Bounded in
 * SQL rather than in JS as the primer does: MCP clients call `resources/list` speculatively, and
 * selecting thousands of rows to hand back 50 is exactly the enumeration cost this surface
 * exists to avoid.
 *
 * Grouped by session_id because file_path - not session_id - is the primary key, and a
 * resource list must never carry the same `sessions://<id>` URI twice. MAX(created_at)
 * makes the surviving row the newest of a collision (SQLite's bare-column rule), the same
 * tie-break resolveSessionFile applies by mtime.
 */
export async function recentSessionsForRepo(
  repo: RepoInfo,
  limit: number,
): Promise<{ rows: RepoSessionRow[]; totalCount: number }> {
  const db = getDb();
  await ensureIndexFresh();

  const scope = repoScopeClause(repoRoots(repo));
  const where = `WHERE ${scope.clause}`;

  const rows = db
    .query<RepoSessionRow, any[]>(
      `SELECT session_id, tool, date, first_prompt, custom_title, MAX(created_at) AS created_at
       FROM sessions ${where}
       GROUP BY session_id
       ORDER BY created_at DESC, date DESC
       LIMIT ?`,
    )
    .all(...scope.params, rowLimit(limit, MAX_REPO_SESSION_ROWS));

  // COUNT(DISTINCT session_id), not COUNT(*): the total has to be countable against the
  // grouped rows above, or a repo with a collision reports more sessions than exist.
  const total = db
    .query<{ n: number }, string[]>(`SELECT COUNT(DISTINCT session_id) AS n FROM sessions ${where}`)
    .get(...scope.params);

  return { rows, totalCount: total?.n ?? 0 };
}

/** One indexed session projected to what correlation (pacifico why) needs. */
export interface CandidateSessionRow {
  file_path: string;
  cwd: string;
  tool: string;
  session_id: string;
  date: string;
  started_at: string;
  ended_at: string;
  first_prompt: string;
  custom_title: string;
  files_touched: string;
}

/**
 * Repo-scoped sessions whose `date` falls in `[after, before]` (inclusive, YYYY-MM-DD).
 *
 * The coarse date bound keeps the scan O(window) rather than O(corpus) - `pacifico why`
 * derives the bound from a commit's authored day plus a buffer, then applies the precise
 * `started_at <= authoredAt <= (ended_at | end-of-day) + slack` rule in JS. Same
 * boundary-aware repo scope as the primer, so linked worktrees aggregate while a
 * same-prefix sibling stays out.
 */
export async function candidateSessionsForRepoWindow(
  repo: RepoInfo,
  after: string,
  before: string,
): Promise<CandidateSessionRow[]> {
  const db = getDb();
  await ensureIndexFresh();

  const scope = repoScopeClause(repoRoots(repo));
  const where = `WHERE ${scope.clause} AND date >= ? AND date <= ?`;

  return db
    .query<CandidateSessionRow, any[]>(
      `SELECT file_path, cwd, tool, session_id, date, started_at, ended_at, first_prompt, custom_title, files_touched
       FROM sessions ${where}
       ORDER BY started_at DESC, date DESC`,
    )
    .all(...scope.params, after, before);
}

/**
 * Repo-scoped sessions whose files_touched mentions `relPath`, newest first, no date
 * bound - the recall side of `why`'s unlanded-attempt bucket, which cannot know when the
 * abandoned work happened. files_touched only, never files_read: an attempt means the
 * session *changed* the file. Same substring-LIKE imprecision contract as the
 * searchSessions files filter; the caller re-checks after repo-relative normalization.
 */
export async function sessionsTouchingFile(repo: RepoInfo, relPath: string): Promise<CandidateSessionRow[]> {
  const db = getDb();
  await ensureIndexFresh();

  const scope = repoScopeClause(repoRoots(repo));
  const escaped = relPath.replace(/[\\%_]/g, (c) => `\\${c}`);

  return db
    .query<CandidateSessionRow, any[]>(
      `SELECT file_path, cwd, tool, session_id, date, started_at, ended_at, first_prompt, custom_title, files_touched
       FROM sessions
       WHERE ${scope.clause} AND files_touched LIKE '%' || ? || '%' ESCAPE '\\'
       ORDER BY started_at DESC, date DESC`,
    )
    .all(...scope.params, escaped);
}

/** Read up to `limit` best FTS message hits for one session, scoped by its file_path. */
export interface SessionExcerptRow {
  msg_index: number;
  role: string;
  snippet: string;
}

/**
 * The best `limit` message excerpts for one session matching `terms` (already an FTS
 * query string). Scoped to the session's `file_path` - the same message_fts MATCH shape
 * searchSessions uses. Returns [] on an empty/blank term set or an FTS syntax error;
 * evidence without quotes is never an error.
 */
export function sessionExcerpts(filePath: string, ftsQuery: string, limit: number): SessionExcerptRow[] {
  if (!ftsQuery) return [];
  const db = getDb();
  try {
    return db
      .query<SessionExcerptRow, [string, string, number]>(
        `SELECT msg_index, role, snippet(message_fts, 3, '', '', '\u2026', 32) AS snippet
         FROM message_fts
         WHERE file_path = ? AND message_fts MATCH ?
         ORDER BY bm25(message_fts, ${MESSAGE_FTS_COLUMN_WEIGHTS.join(', ')})
         LIMIT ?`,
      )
      .all(filePath, ftsQuery, limit)
      .filter((r) => r.msg_index >= 0);
  } catch {
    return [];
  }
}
