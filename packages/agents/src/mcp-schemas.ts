// The MCP tools' `outputSchema` shapes, kept out of src/mcp.ts so that file stays readable.
//
// Two invariants govern everything here:
//
//  1. **Every schema must admit its tool's empty-result case.** The SDK validates
//     `structuredContent` against these on every non-`isError` call, so a schema that
//     only describes the populated shape turns each of the 7 sentinel paths into a
//     runtime error the `run*` seam tests cannot see. Arrays therefore accept `[]`, and
//     anything absent on an empty path is `.optional()`.
//  2. **A top-level array is not a legal `structuredContent`.** The SDK requires a JSON
//     object; registering `z.array(...)` silently drops `outputSchema` from `tools/list`
//     and fails the call with an unrelated-looking message. The two array-returning tools
//     therefore ship a `{ results, count }` envelope.
//
// Known limitation, carried deliberately: there is no compile-time link between these
// schemas and the interfaces in src/types.ts that they mirror. A renamed or removed field
// there becomes a runtime MCP error here, not a type error. Deriving these from the
// interfaces is recorded as a future item in the contract.
import { z } from 'zod';

const toolName = z.enum(['claude', 'pi', 'codex', 'opencode']);
const role = z.enum(['user', 'assistant']);
const period = z.object({ start: z.string(), end: z.string() });
/** Hour-of-day / tool-name → count maps, which serialize as plain objects. */
const counts = z.record(z.string(), z.number());

// --- search_sessions ---

const messageHit = z.object({
  index: z.number(),
  role,
  snippet: z.string(),
});

/** Mirrors FormattedResult (src/search-format.ts), including the two truncation counts. */
const formattedResult = z.object({
  sessionId: z.string(),
  tool: toolName,
  date: z.string(),
  createdAt: z.string(),
  project: z.string(),
  title: z.string().nullable(),
  snippet: z.string(),
  messageCount: z.number(),
  files: z.array(z.string()),
  fileCount: z.number(),
  commands: z.array(z.string()),
  commandCount: z.number(),
  errored: z.boolean(),
  exists: z.boolean(),
  filePath: z.string(),
  resumeCommand: z.string(),
  // Pi lineage: /tree in-file fork count and the /fork parent basename ('' when none).
  branches: z.number(),
  forkedFrom: z.string(),
  // Absent on the no-index scanner fallback, empty on a metadata-only match.
  messageHits: z.array(messageHit).optional(),
});

export const SearchSessionsOutput = z.object({
  results: z.array(formattedResult),
  count: z.number(),
});

// --- grep_sessions ---

export const GrepSessionsOutput = z.object({
  totalHits: z.number(),
  totalSessions: z.number(),
  returnedHits: z.number(),
  truncated: z.boolean(),
  hits: z.array(
    z.object({
      tool: toolName,
      project: z.string(),
      sessionId: z.string(),
      filePath: z.string(),
      date: z.string(),
      role,
      msgIndex: z.number(),
      snippet: z.string(),
      resumeCommand: z.string(),
    }),
  ),
});

// --- get_session_messages ---

export const GetSessionMessagesOutput = z.object({
  total: z.number(),
  offset: z.number(),
  returned: z.number(),
  messages: z.array(
    z.object({
      role,
      text: z.string(),
      // Only present when include_tools was set.
      tools: z.array(z.string()).optional(),
      // Pi branch labels - only ever 'abandoned' in practice, and absent on
      // unbranched sessions (conditional-spread purity in runGetSessionMessages).
      branch: z.enum(['active', 'abandoned']).optional(),
      // A FIELD on the branch's first message, never a synthetic row: inserting a
      // marker message would shift `total` and drift every search-hit offset.
      fork: z
        .object({
          fromIndex: z.number(),
          abandonedCount: z.number(),
          firstUserText: z.string(),
          timestamp: z.string(),
          // Human-readable rendering for chat display; the structured fields above
          // serve programmatic consumers.
          marker: z.string(),
        })
        .optional(),
    }),
  ),
});

// --- get_session_digest ---

export const GetSessionDigestOutput = z.object({
  messageCount: z.number(),
  exchangeCount: z.number(),
  elided: z.number(),
  // Empty for a session with no genuine human turns.
  exchanges: z.array(z.object({ index: z.number(), user: z.string(), assistant: z.string() })),
});

// --- get_activity_digest ---

const digestSessionDetail = z.object({
  sessionId: z.string(),
  tool: z.string(),
  title: z.string(),
  messageCount: z.number(),
  filePath: z.string(),
  userMessages: z.array(z.string()),
});

const digestProjectGroup = z.object({
  project: z.string(),
  sessions: z.number(),
  totalMessages: z.number(),
  tools: z.array(z.string()),
  topics: z.array(z.string()),
  filePaths: z.array(z.string()),
  // Only populated at detail: 'highlights' | 'full'.
  sessionDetails: z.array(digestSessionDetail).optional(),
});

export const GetActivityDigestOutput = z.object({
  period,
  totalSessions: z.number(),
  totalMessages: z.number(),
  tools: counts,
  projects: z.array(z.string()),
  days: z.array(z.object({ date: z.string(), sessions: z.number(), projects: z.array(digestProjectGroup) })),
});

// --- get_session_metrics ---

export const GetSessionMetricsOutput = z.object({
  period,
  totalSessions: z.number(),
  totalMessages: z.number(),
  toolBreakdown: counts,
  projectBreakdown: z.array(z.object({ project: z.string(), sessions: z.number(), messages: z.number() })),
  dailyActivity: z.array(z.object({ date: z.string(), sessions: z.number(), messages: z.number() })),
  activeHours: counts,
});

// --- get_context_primer ---

export const GetContextPrimerOutput = z.object({
  // '' on the not-a-git-repo sentinel, where there is no repo to label.
  repoLabel: z.string(),
  toolFilter: z.enum(['claude', 'pi', 'codex', 'opencode', '']),
  recent: z.array(
    z.object({
      sessionId: z.string(),
      tool: toolName,
      branch: z.string(),
      date: z.string(),
      messageCount: z.number(),
      intent: z.string(),
      files: z.array(z.string()),
      fileCount: z.number(),
      opening: z.string(),
      closing: z.object({ user: z.string(), assistant: z.string() }),
    }),
  ),
  headlines: z.array(z.object({ date: z.string(), tool: toolName, branch: z.string(), intent: z.string() })),
  isEmpty: z.boolean(),
});

// --- why_did_this_change ---

/** Mirrors WhyEvidence (src/why/correlate.ts). A JSON object, never a top-level array;
 *  `commit` is null on the query form and `sessions` admits the empty case. */
/** One correlated session. Shared by `sessions` (produced the commit) and
 *  `unlandedAttempts` (touched the file, no commit in its history - file form only). */
const WhySession = z.object({
  filePath: z.string(),
  tool: z.string(),
  sessionId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  headline: z.string(),
  overlappingFiles: z.array(z.string()),
  confidence: z.enum(['files+time', 'time-only']),
  excerpts: z.array(z.object({ msgIndex: z.number(), role: z.string(), text: z.string() })),
  resume: z.string(),
});

export const WhyDidThisChangeOutput = z.object({
  commit: z
    .object({
      sha: z.string(),
      subject: z.string(),
      authoredAt: z.string(),
      files: z.array(z.string()),
      trailers: z.array(z.string()),
      merge: z.boolean(),
    })
    .nullable(),
  sessions: z.array(WhySession),
  unlandedAttempts: z.array(WhySession),
});

// A discriminated result inside an object keeps MCP's output schema object-shaped.
export const SearchOutput = z.object({
  result: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('ranked'), data: SearchSessionsOutput }),
    z.object({ mode: z.literal('literal'), data: GrepSessionsOutput }),
    z.object({ mode: z.literal('regex'), data: GrepSessionsOutput }),
  ]),
});
export const ReadSessionOutput = z.object({
  result: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('digest'), data: GetSessionDigestOutput }),
    z.object({ mode: z.literal('messages'), data: GetSessionMessagesOutput }),
  ]),
});
export const ContextOutput = z.object({
  result: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('project'), data: GetContextPrimerOutput }),
    z.object({ mode: z.literal('activity'), data: GetActivityDigestOutput }),
  ]),
});
