import { z } from 'zod';

import { type Tool } from './types';
import {
  extractUserText,
  isGenuineUserTurn,
  isUserMessage,
  stripInjected,
  asJsonObject,
  asJsonString,
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from './extract-util';

interface JsonLine {
  type?: string;
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  gitBranch?: string;
  customTitle?: string;
  promptSource?: string | null;
  /** Claude marks auto-generated context-carryover turns (the "continued from a
   *  previous conversation" summary written on compaction) with this flag. */
  isCompactSummary?: boolean;
  /** True on every line of a subagent (Task) transcript - which carries the
   *  PARENT sessionId, so its injected "user" prompt would otherwise pass for
   *  the human speaking mid-session. */
  isSidechain?: boolean;
  message?: JsonObject | string;
  payload?: JsonObject;
}

function tryParseJson(line: string): JsonLine | null {
  try {
    // SAFETY: JSON.parse's range is the JSON domain; JsonLine's fields are all
    // optional, and every read below re-narrows (asJsonObject/asJsonString or a
    // comparison) before use. Deep schema validation on this hot path costs real
    // indexing time for no additional safety.
    return JSON.parse(line) as JsonLine | null;
  } catch {
    return null;
  }
}

export interface SessionMetadata {
  sessionId?: string;
  cwd: string;
  customTitle: string;
  date: string;
  createdAt: string;
  /**
   * The first timestamp in full, not truncated to a day like `createdAt`.
   *
   * The index needs the time of day for the active-hours histogram. Without this
   * column get_session_metrics made a second pass over every matched row, reopening
   * each transcript from disk purely to read line 1's clock.
   */
  startedAt: string;
  /**
   * The last timestamp in full, not truncated to a day like `date`.
   *
   * Correlation (pacifico why) needs a session's end instant to test whether a
   * commit's authored time falls inside its window. '' when the transcript carries
   * no full ISO timestamp; callers fall back to end-of-day of `date`.
   */
  endedAt: string;
  messageCount: number;
  branch: string;
}

/**
 * Extract the session-level fields needed by the index in one JSON parse pass.
 * These used to be collected by six independent helpers, which made indexing an
 * actively growing (and often multi-megabyte) transcript parse the same JSONL
 * records over and over.
 */
export function extractSessionMetadata(lines: string[], tool: Tool): SessionMetadata {
  let sessionId: string | undefined;
  let cwd = '';
  let title = '';
  let firstDate = '?';
  let firstTs = '';
  let lastTs = '';
  let lastDate = '?';
  let count = 0;
  let branch = '';

  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (!sessionId) {
      const candidate =
        tool === 'codex'
          ? d.type === 'session_meta'
            ? asJsonString(d.payload?.id)
            : undefined
          : tool === 'claude' || d.type === 'session'
            ? asJsonString(d.sessionId)
            : undefined;
      if (candidate?.trim()) sessionId = candidate;
    }

    if (!cwd) {
      if (tool === 'claude' && d.cwd) {
        cwd = d.cwd;
      } else if (
        (tool === 'opencode' || tool === 'cursor' || tool === 'antigravity') &&
        d.type === 'session' &&
        d.cwd
      ) {
        cwd = d.cwd;
      } else if (tool === 'codex' && d.type === 'session_meta') {
        const value = asJsonString(d.payload?.cwd);
        if (value) cwd = value;
      }
    }

    title = titleFromRecord(d) ?? title;

    if (d.timestamp?.[0] === '2') {
      const date = d.timestamp.slice(0, 10);
      if (firstDate === '?') {
        firstDate = date;
        firstTs = d.timestamp;
      }
      lastTs = d.timestamp;
      lastDate = date;
    }

    if (isUserMessage(d) || d.type === 'assistant') {
      count++;
    } else if (d.type === 'message') {
      if (asJsonObject(d.message)?.role === 'assistant') count++;
    } else if (d.type === 'response_item') {
      // The same envelope gap extractMessages had, in the counting loop. Left unfixed,
      // every Codex row indexed with message_count 0 even once its messages parsed -
      // `developer` is excluded here for the same reason it is there: injected framing.
      const p = d.payload;
      const role = p?.['type'] === 'message' ? p['role'] : undefined;
      if (role === 'user' || role === 'assistant') count++;
    }

    if (tool === 'claude') {
      const b = asJsonString(d.gitBranch);
      if (b) branch = b;
    } else if (tool === 'codex' && !branch && d.type === 'session_meta') {
      const b = asJsonString(asJsonObject(d.payload?.git)?.branch);
      if (b) branch = b;
    }
  }

  return {
    ...(sessionId ? { sessionId } : {}),
    cwd,
    customTitle: title,
    date: lastDate,
    createdAt: firstDate,
    startedAt: firstTs,
    endedAt: lastTs,
    messageCount: count,
    branch,
  };
}

export function getCwdFromSession(lines: string[], tool: Tool): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;

    if (tool === 'claude') {
      if (d.cwd) return d.cwd;
    } else if (tool === 'opencode' || tool === 'cursor' || tool === 'antigravity') {
      // Database readers emit a session header with the native workspace.
      if (d.type === 'session' && d.cwd) return d.cwd;
    } else if (tool === 'codex') {
      if (d.type === 'session_meta') {
        const cwd = asJsonString(d.payload?.cwd);
        if (cwd) return cwd;
      }
    }
  }
  return '';
}

/**
 * The git branch a session ran on, read from the logs (not the current worktree).
 * Claude writes `gitBranch` on every line, so the last non-empty one is "where
 * you left off". Codex records its starting branch once in `session_meta`. Other sources return ''.
 */
export function sessionBranch(lines: string[], tool: Tool): string {
  if (tool === 'codex') {
    for (const line of lines) {
      const d = tryParseJson(line);
      if (d?.type !== 'session_meta') continue;
      const b = asJsonString(asJsonObject(d.payload?.git)?.branch);
      if (b) return b;
    }
    return '';
  }
  if (tool === 'claude') {
    let branch = '';
    for (const line of lines) {
      const d = tryParseJson(line);
      const b = asJsonString(d?.gitBranch);
      if (b) branch = b; // keep the last non-empty
    }
    return branch;
  }
  return ''; // No verified branch field for this source.
}

function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

export interface GenuineUserTurn {
  sessionId: string;
  timestamp: string;
  text: string;
}

/**
 * A genuine human turn with its place in time - the boundary marker wrapped's
 * loop metric splits autonomous runs on. Takes an already-parsed JSONL line
 * (the report walkers yield parsed objects, not strings). Beyond the
 * `isGenuineUserTurn` rules this also rejects sidechain lines: a subagent
 * transcript carries the parent sessionId, so its injected task prompt would
 * otherwise read as the human speaking mid-loop.
 */
const userTurnLineSchema = z.object({
  type: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  promptSource: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  message: z.union([z.string(), jsonObjectSchema]).optional(),
});

export function genuineUserTurnFromLine(input: JsonValue): GenuineUserTurn | null {
  const parsed = userTurnLineSchema.safeParse(input);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (d.isSidechain === true || !isUserMessage(d)) return null;
  const { sessionId, timestamp } = d;
  if (!sessionId || !timestamp) return null;
  const text = extractUserText(d).trim();
  if (!text || !isGenuineUserTurn(d, text)) return null;
  return { sessionId, timestamp, text };
}

/** Genuine human user turns, in order, as stripped (not length-clamped) text. */
export function genuineUserTexts(lines: string[], _tool: Tool): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d).trim(); // extractUserText already stripInjected
    if (text && isGenuineUserTurn(d, text)) out.push(text);
  }
  return out;
}

export function firstPrompt(lines: string[], tool: Tool): string {
  const genuine = genuineUserTexts(lines, tool);
  return genuine.length ? clean(genuine[0]!) : '';
}

function titleFromRecord(record: JsonLine): string | undefined {
  if (record.type === 'custom-title') return asJsonString(record.customTitle) ?? '';
  if (record.type === 'event_msg' && record.payload?.type === 'thread_name_updated') {
    const name = asJsonString(record.payload.thread_name);
    if (name?.trim()) return name;
  }
}

export function customTitle(lines: string[]): string {
  let title = '';
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    title = titleFromRecord(d) ?? title;
  }
  return title;
}

export function firstTimestamp(lines: string[]): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    const ts = asJsonString(d.timestamp);
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function messageCount(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d) continue;
    if (isUserMessage(d) || d.type === 'assistant') count++;
    else if (d.type === 'message') {
      if (asJsonObject(d.message)?.role === 'assistant') count++;
    }
  }
  return count;
}

/**
 * The last dated line in a transcript. Scans backwards, so the common case (the
 * final line carries a timestamp) still returns on the first iteration.
 *
 * This is the differential oracle for `extractSessionMetadata().date` - the two
 * must agree exactly. An earlier version searched only the last 200 lines and,
 * finding nothing dated there, fell back to the *first* timestamp in the file;
 * that fallback reported a session's date as its start rather than its end, and
 * no real transcript ever reached it (Claude dates every line).
 */
export function lastTimestamp(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = tryParseJson(lines[i]!);
    if (!d) continue;
    const ts = asJsonString(d.timestamp);
    if (ts && ts[0] === '2') return ts.slice(0, 10);
  }
  return '?';
}

export function contentMatches(lines: string[], query: string): boolean {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    if (text.toLowerCase().includes(query)) return true;
  }
  return false;
}

/** A tool invocation the assistant made, reduced to its name and one salient input. */
export interface ToolUse {
  name: string;
  /** One-line, human-readable summary of the salient input (command, path, url, …); '' if none. */
  summary: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
  index: number;
  /** Tool calls belonging to this turn (empty for most user turns). See extractMessages. */
  tools: ToolUse[];
}

/** Input fields, most-informative first, used to summarize a tool call for display. */
const TOOL_SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
  'old_string',
];

/** Reduce a tool_use input object to a single short, human-readable line. */
function summarizeToolInput(input: JsonValue | undefined): string {
  const o = asJsonObject(input);
  if (!o) return '';
  let val: string | undefined;
  for (const k of TOOL_SUMMARY_KEYS) {
    const v = asJsonString(o[k]);
    if (v?.trim()) {
      val = v;
      break;
    }
  }
  val ??= Object.values(o)
    .map(asJsonString)
    .find((v) => v !== undefined && v.trim());
  if (!val) return '';
  const s = val.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * The tool_use blocks on a single assistant/message line, in order. Recognizes the
 * Claude/Anthropic content-array shape (`{type:'tool_use', name, input}`); returns []
 * for shapes it doesn't model (some native tool calls), which is a display-only gap.
 */
function extractToolUses(d: JsonLine): ToolUse[] {
  const msg = asJsonObject(d.message);
  if (!msg) return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const c of content) {
    const rec = asJsonObject(c);
    if (rec && rec.type === 'tool_use') {
      out.push({ name: asJsonString(rec.name) ?? '?', summary: summarizeToolInput(rec.input) });
    }
  }
  return out;
}

function extractAssistantText(d: JsonLine): string {
  const msg = asJsonObject(d.message);
  if (d.type === 'assistant') {
    const msgString = asJsonString(d.message);
    if (msgString !== undefined) return msgString;
    if (!msg) return '';
    return contentText(msg.content);
  }
  if (d.type === 'message') {
    if (!msg || msg.role !== 'assistant') return '';
    return contentText(msg.content);
  }
  return '';
}

/** The joined text of a message's `text` content blocks, or the string content itself. */
function contentText(content: JsonValue | undefined): string {
  const asString = asJsonString(content);
  if (asString !== undefined) return asString;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const c of content) {
      const block = asJsonObject(c);
      if (block && block.type === 'text') {
        // No type gate on text: the old casts pushed the value raw and join
        // stringified it; String() keeps that exact behavior.
        texts.push(block.text === null || block.text === undefined ? '' : String(block.text));
      }
    }
    return texts.join(' ');
  }
  return '';
}

export interface ExtractedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Sequential over ALL non-empty messages - identical to getSessionMessages numbering. */
  index: number;
  /** user turns: isGenuineUserTurn; assistant turns: always true. */
  genuine: boolean;
  /**
   * Tool calls belonging to this turn. A pure-tool-use assistant line carries no text
   * and so gets no index of its own; its calls fold into the current turn's head
   * message here. This keeps numbering dense (array[i].index === i) - the invariant
   * get_session_messages pagination and search-hit offsets both depend on.
   */
  tools: ToolUse[];
}

export interface MessageSummary {
  firstPrompt: string;
  closingUser: string;
  closingAssistant: string;
}

// --- Codex ---

/**
 * Text that arrives on a user-role line but is not the human speaking. Codex writes no
 * `promptSource`, so these prefixes are the shape of every injection observed across the
 * real corpus (305 rollouts, 1,022 user records, 417 of them injections).
 *
 * `Warning: ` is the harness scolding itself - "Warning: apply_patch was requested via
 * exec_command…" - and it is the one prefix that could plausibly open a human turn. It is
 * still tested before the event_msg join rather than after, because the sessions carrying
 * it are exactly the ones with no `user_message` events to join against.
 */
const CODEX_INJECTED =
  /^(<environment_context|<user_action|<turn_aborted|<recommended_plugins|<image\b|<skill\b|<user_shell_command|# AGENTS\.md instructions for |Warning: )/;

/** How far in to look for the Codex envelope. Every real rollout opens with `session_meta`
 *  on line 1; the slack absorbs a truncated or blank-padded head. */
const CODEX_SNIFF_LINES = 20;

/**
 * Whether these lines are a Codex rollout.
 *
 * Sniffed rather than passed in: getSessionMessages runs from mcp.ts and cache.ts with
 * nothing but a file's lines, so a `tool` parameter would have to be threaded through
 * every caller. The check reads the PARSED top-level `type` and never a substring of the
 * raw line - a transcript that merely discusses Codex has `response_item` in its prose.
 */
function isCodexTranscript(lines: string[]): boolean {
  const n = Math.min(lines.length, CODEX_SNIFF_LINES);
  for (let i = 0; i < n; i++) {
    const t = tryParseJson(lines[i] ?? '')?.type;
    if (t === 'session_meta' || t === 'response_item') return true;
  }
  return false;
}

/** The text of a Codex payload's content blocks of `kind`, joined. */
function codexText(payload: JsonObject, kind: 'input_text' | 'output_text'): string {
  const content = payload['content'];
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const c of content) {
    const block = asJsonObject(c);
    if (block && block['type'] === kind) {
      // Same String() parity as contentText: the old cast pushed the value raw.
      texts.push(block['text'] === null || block['text'] === undefined ? '' : String(block['text']));
    }
  }
  return texts.join(' ');
}

/** A Codex tool call, whatever envelope it arrived in. */
function codexToolUse(p: JsonObject): ToolUse {
  const name = asJsonString(p['name']) ?? String(p['type'] ?? '?');
  // Codex ships arguments three ways: a JSON string (`function_call.arguments`), the raw
  // payload itself (`custom_tool_call.input` - a patch or a script), and an object.
  const raw = p['arguments'] ?? p['input'] ?? p['action'];
  const rawString = asJsonString(raw);
  if (rawString !== undefined) {
    try {
      const parsed = asJsonObject(JSON.parse(rawString));
      if (parsed) return { name, summary: summarizeToolInput(parsed) };
    } catch {
      // Not JSON - it is the patch or script text itself, so summarize it directly.
    }
    const s = rawString.replace(/\s+/g, ' ').trim();
    return { name, summary: s.length > 120 ? s.slice(0, 120) + '…' : s };
  }
  return { name, summary: summarizeToolInput(raw) };
}

/**
 * Reconcile model-facing response items with UI message events. A response copy
 * takes precedence; unmatched UI occurrences remain searchable. Original JSONL
 * stays unchanged in the archive. User-event text also identifies typed input.
 */
function extractCodexMessages(lines: string[]): ExtractedMessage[] {
  const parsed = lines.map(tryParseJson);
  // UI events can be the only visible copy of a message. Match each
  // response occurrence once, so repeated equal messages retain their count.
  const responseCounts = new Map<string, Map<string | null, number>>();
  for (const record of parsed) {
    const p = record?.payload;
    if (record?.type !== 'response_item' || p?.type !== 'message') continue;
    const role = p.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = codexText(p, role === 'user' ? 'input_text' : 'output_text');
    const key = JSON.stringify([role, text.trim()]);
    const turn = asJsonString(p.turn_id) ?? null;
    const counts = responseCounts.get(key) ?? new Map<string | null, number>();
    counts.set(turn, (counts.get(turn) ?? 0) + 1);
    responseCounts.set(key, counts);
  }
  const completedIds = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const record = parsed[i];
    if (record?.type !== 'event_msg' || !record.payload) continue;
    const item = record.payload.type === 'item_completed' ? asJsonObject(record.payload.item) : undefined;
    const role =
      record.payload.type === 'user_message' || item?.type === 'UserMessage'
        ? 'user'
        : record.payload.type === 'agent_message' || item?.type === 'AgentMessage'
          ? 'assistant'
          : null;
    if (!role) continue;
    const text = item
      ? Array.isArray(item.content)
        ? item.content.map((part) => asJsonString(asJsonObject(part)?.text) ?? '').join('')
        : ''
      : (asJsonString(record.payload.message) ?? '');
    if (!text.trim()) continue;
    const nativeId = item && asJsonString(item.id);
    if (nativeId) {
      const identity = JSON.stringify([asJsonString(record.payload.turn_id) ?? null, nativeId, role, text]);
      if (completedIds.has(identity)) continue;
      completedIds.add(identity);
    }
    const key = JSON.stringify([role, text.trim()]);
    const counts = responseCounts.get(key);
    const turn = asJsonString(record.payload.turn_id) ?? null;
    // Explicitly different turns cannot be copies of the same message.
    const candidates = turn === null ? [...(counts?.keys() ?? [])] : [turn, null];
    const matchingTurn = candidates.find((candidate) => (counts?.get(candidate) ?? 0) > 0);
    if (matchingTurn !== undefined && counts) {
      counts.set(matchingTurn, counts.get(matchingTurn)! - 1);
      continue;
    }
    parsed[i] = {
      ...record,
      type: 'response_item',
      payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
    };
  }

  // Pass 1: the genuineness oracle. The `user_message` event usually lands AFTER its
  // `response_item` twin, so this cannot fold into the emit pass below.
  const typed = new Set<string>();
  const userTexts: string[] = [];
  for (const d of parsed) {
    if (!d?.payload) continue;
    if (d.type === 'event_msg' && d.payload['type'] === 'user_message') {
      const m = asJsonString(d.payload['message']);
      if (m?.trim()) typed.add(m.trim());
    } else if (d.type === 'response_item' && d.payload['type'] === 'message' && d.payload['role'] === 'user') {
      const t = stripInjected(codexText(d.payload, 'input_text')).trim();
      if (t) userTexts.push(t);
    }
  }
  // Trust the join only where it demonstrably joins. If Codex ever normalized whitespace
  // differently between the two streams, every turn would silently flip to genuine:false
  // and first_prompt would go blank again - indistinguishable from the bug this fixes. A
  // session whose streams do not meet falls back to the injection prefixes alone.
  const joins = typed.size > 0 && userTexts.some((t) => typed.has(t));

  const messages: ExtractedMessage[] = [];
  let idx = 0;
  // The turn's head message - where a following pure-tool-call line's calls attach.
  let current: ExtractedMessage | null = null;
  let pending: ToolUse[] = [];

  for (const d of parsed) {
    if (!d || d.type !== 'response_item' || !d.payload) continue;
    const p = d.payload;
    switch (p['type']) {
      case 'message': {
        if (p['role'] === 'user') {
          const text = stripInjected(codexText(p, 'input_text'));
          const trimmed = text.trim();
          if (!trimmed) break;
          const genuine = !CODEX_INJECTED.test(trimmed) && (!joins || typed.has(trimmed));
          current = { role: 'user', text, index: idx++, genuine, tools: pending };
          pending = [];
          messages.push(current);
        } else if (p['role'] === 'assistant') {
          const text = codexText(p, 'output_text');
          if (!text.trim()) break;
          current = { role: 'assistant', text, index: idx++, genuine: true, tools: pending };
          pending = [];
          messages.push(current);
        }
        // Any other role (`developer`, `system`) is injected framing, not a turn.
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'web_search_call':
      case 'tool_search_call': {
        // A pure tool-call line carries no text and so gets no index of its own; its
        // call folds into the head of the current turn, exactly as the Claude path does.
        const call = codexToolUse(p);
        if (current) current.tools.push(call);
        else pending.push(call);
        break;
      }
    }
  }
  return messages;
}

/**
 * The single numbering authority for message extraction. Every non-empty
 * user/assistant message in order, with a sequential index and a `genuine` flag
 * for user turns (injected skill bodies and tool results still consume an index -
 * they are counted, just flagged - so genuineness is metadata, never numbering).
 * Search-hit indices (message_fts) and get_session_messages pagination must agree
 * exactly, so both derive from this function.
 */
export function extractMessages(lines: string[]): ExtractedMessage[] {
  // Codex nests its messages under a `response_item` envelope the dispatch below does
  // not model, which is why every Codex transcript extracted to zero messages.
  if (isCodexTranscript(lines)) return extractCodexMessages(lines);

  const messages: ExtractedMessage[] = [];
  let idx = 0;
  // The turn's head message - where a following pure-tool-use line's calls attach.
  let current: ExtractedMessage | null = null;
  // Tool calls seen before any message was emitted (rare: a session opening on a tool
  // call). Buffered here and flushed onto the first emitted message.
  let pending: ToolUse[] = [];
  for (let li = 0; li < lines.length; li++) {
    const d = tryParseJson(lines[li]!);
    if (!d) continue;
    if (isUserMessage(d)) {
      const text = extractUserText(d);
      if (text.trim()) {
        current = { role: 'user', text, index: idx++, genuine: isGenuineUserTurn(d, text.trim()), tools: pending };
        pending = [];
        messages.push(current);
      }
      // A user line with no text is a tool_result/empty turn - it carries no tool_use
      // and must not reset `current` (assistant calls after it still belong to the turn).
    } else {
      const text = extractAssistantText(d);
      const tools = extractToolUses(d);
      if (text.trim()) {
        current = { role: 'assistant', text, index: idx++, genuine: true, tools: pending.concat(tools) };
        pending = [];
        messages.push(current);
      } else if (tools.length) {
        // Pure tool-use turn: no text row (so no index), fold its calls into the head.
        if (current) current.tools.push(...tools);
        else pending.push(...tools);
      }
    }
  }
  return messages;
}

/** Returns public message fields in the same order as search-hit offsets. */
export function getSessionMessages(lines: string[]): SessionMessage[] {
  return extractMessages(lines).map(({ role, text, index, tools }) => ({ role, text, index, tools }));
}

/** Max length of each stored closing message (bounds the indexed columns). */
export const CLOSING_MAX = 500;

/**
 * Remove output-style "★ Insight" marker lines and their `──` fence lines while
 * keeping the body text, then collapse the blank runs they leave behind. This is
 * markup cleanup, not outcome detection - the body (often the useful part) stays.
 */
export function stripInsightFences(text: string): string {
  // Match only the literal output-style markup: a `★ Insight` marker line and
  // box-drawing `─` fence lines. Requiring the star and the `─` char (not ASCII
  // `-`) avoids eating a genuine markdown `-----` rule or a bare "Insight" line.
  const kept = text.split('\n').filter((l) => !/^\s*★\s*Insight\s*─*\s*$/.test(l) && !/^\s*─{5,}\s*$/.test(l));
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the prompt/closing columns from an extraction the index already needs
 * for message_fts. Keeping this as a projection avoids three additional full
 * transcript passes in the hot indexing path.
 */
export function summarizeMessages(messages: ExtractedMessage[]): MessageSummary {
  let first = '';
  let lastUser = '';
  let lastAssistant = '';

  for (const message of messages) {
    if (message.role === 'user' && message.genuine) {
      if (!first) first = message.text;
      lastUser = message.text;
    } else if (message.role === 'assistant') {
      lastAssistant = message.text;
    }
  }

  const finish = (text: string): string => {
    const stripped = stripInjected(text).trim();
    return stripped.length > CLOSING_MAX ? stripped.slice(0, CLOSING_MAX) : stripped;
  };

  return {
    firstPrompt: first ? clean(first) : '',
    closingUser: finish(lastUser),
    closingAssistant: finish(stripInsightFences(lastAssistant)),
  };
}

/**
 * Last user message and last assistant message from a session, stripped of
 * injected tags and truncated to CLOSING_MAX. Both roles are returned so the
 * synthesis layer (Phase 2) can decide what the open thread is - the last
 * assistant turn alone is often a question or tool call, not an outcome.
 */
export interface ClosingMessages {
  user: string;
  assistant: string;
}

export function closingMessages(lines: string[]): ClosingMessages {
  const summary = summarizeMessages(extractMessages(lines));
  return { user: summary.closingUser, assistant: summary.closingAssistant };
}

export function findMatchContext(lines: string[], query: string): string {
  for (const line of lines) {
    const d = tryParseJson(line);
    if (!d || !isUserMessage(d)) continue;
    const text = extractUserText(d);
    const pos = text.toLowerCase().indexOf(query);
    if (pos >= 0) {
      const start = Math.max(0, pos - 30);
      const end = Math.min(text.length, pos + query.length + 70);
      let snippet = text.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < text.length) snippet = snippet + '…';
      return snippet;
    }
  }
  return '';
}
