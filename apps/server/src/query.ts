import { remoteId, parseRemoteId, type Identity, type Snapshot, type ToolName } from '@pacifico/core/sync/protocol';
import { buildSessionDigest } from '@pacifico/core/digest';
import { getSessionMessages } from '@pacifico/core/parser';
import { pageSessionEvents } from '@pacifico/core/retrieval/events';
import type { Store } from './store';
import { z } from 'zod';

interface Row {
  key: string;
  device_id: string;
  device: string;
  item: Snapshot;
  projection: {
    title: string;
    opening: string;
    date: string;
    createdAt: string;
    closing?: { user: string; assistant: string };
    branch: string;
    files: string[];
    commands: string[];
    errored: boolean;
    messageCount: number;
  };
}
const number = (value: unknown, fallback: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .parse(value ?? fallback);
const offset = (value: unknown) =>
  z
    .number()
    .int()
    .min(0)
    .parse(value ?? 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
function origin(row: Row) {
  return { deviceId: row.device_id, device: row.device, sourcePath: row.item.sourcePath };
}
function formatted(row: Row) {
  const p = row.projection;
  return {
    sessionId: row.item.sessionId,
    tool: row.item.harness,
    date: p.date,
    createdAt: p.createdAt,
    project: row.item.cwd,
    title: p.title || null,
    snippet: p.opening.slice(0, 500),
    messageCount: p.messageCount,
    files: p.files.slice(0, 10),
    fileCount: p.files.length,
    commands: p.commands.slice(0, 5),
    commandCount: p.commands.length,
    errored: p.errored,
    exists: false,
    filePath: remoteId(row.device_id, row.key),
    resumeCommand: '',
    origin: origin(row),
    messageHits: [],
  };
}
export function queryTools(store: Store, identity: Identity, excludeDevice?: string) {
  const sql = store.sql;
  async function rows(args: Record<string, unknown>, documents = false, all = false): Promise<Row[]> {
    const params: unknown[] = [identity.userId];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const conditions = ['s.user_id=$1', documents ? "s.item->>'kind' <> 'session'" : "s.item->>'kind' = 'session'"];
    const dateField = all ? 'createdAt' : 'date';
    if (excludeDevice) conditions.push(`s.device_id <> ${bind(excludeDevice)}::uuid`);
    if (args.device) conditions.push(`s.device_id = ${bind(args.device)}::uuid`);
    if (args.tool) conditions.push(`s.item->>'harness' = ${bind(args.tool)}`);
    if (args.project || args.cwd) conditions.push(`s.item->>'cwd' = ${bind(args.project ?? args.cwd)}`);
    if (args.after) conditions.push(`s.projection->>'${dateField}' >= ${bind(args.after)}`);
    if (args.before) conditions.push(`s.projection->>'${dateField}' <= ${bind(args.before)}`);
    if (args.errored) conditions.push(`s.projection->>'errored' = 'true'`);
    if (Array.isArray(args.files))
      for (const file of args.files)
        conditions.push(
          `EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.projection->'files') f WHERE strpos(f,${bind(file)})>0)`,
        );
    const query = text(args.query).trim();
    if (query.length > 1000) throw new Error('Query must be at most 1000 characters');
    const queryParam = query ? bind(query) : '';
    if (query)
      conditions.push(
        `EXISTS (SELECT 1 FROM search_chunks c WHERE c.user_id=s.user_id AND c.device_id=s.device_id AND c.key=s.key AND c.tokens @@ plainto_tsquery('simple',${queryParam}))`,
      );
    const order = query
      ? `(SELECT max(ts_rank(c.tokens,plainto_tsquery('simple',${queryParam}))) FROM search_chunks c WHERE c.user_id=s.user_id AND c.device_id=s.device_id AND c.key=s.key) DESC,`
      : '';
    const limit = all ? '' : ` LIMIT ${bind(number(args.limit, 20, 200))}`;
    return sql.unsafe(
      `SELECT s.key,s.device_id,s.item-'content' AS item,s.projection,d.name AS device FROM snapshots s JOIN devices d ON d.id=s.device_id WHERE ${conditions.join(' AND ')} ORDER BY ${order} s.projection->>'date' DESC,s.device_id,s.key${limit}`,
      params,
    ) as Promise<Row[]>;
  }
  async function read(id: string): Promise<Row> {
    const parsed = parseRemoteId(id);
    const [row] = await sql`SELECT s.*,d.name AS device FROM snapshots s JOIN devices d ON d.id=s.device_id
      WHERE s.user_id=${identity.userId} AND s.device_id=${parsed.device} AND s.key=${parsed.key}`;
    if (!row) throw new Error('Remote record not found');
    return row;
  }
  return async (name: ToolName, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === 'native_documents') {
      if (args.mode === 'read') {
        if (args.query !== undefined) throw new Error('Read accepts no query');
        const row = await read(text(args.id));
        if (row.item.kind === 'session') throw new Error('Expected a native document');
        const start = offset(args.offset),
          limit = number(args.limit, 12000, 20000);
        return {
          mode: 'read',
          document: {
            id: remoteId(row.device_id, row.key),
            harness: row.item.harness,
            kind: row.item.kind,
            path: row.item.sourcePath,
            modifiedAt: row.item.modifiedAt,
            content: row.item.content.slice(start, start + limit),
            offset: start,
            total: row.item.content.length,
            truncated: start + limit < row.item.content.length,
            origin: origin(row),
          },
        };
      }
      if (!text(args.query).trim() || args.id !== undefined || args.offset !== undefined)
        throw new Error('Search requires query and accepts no id or offset');
      const found = await rows({ ...args, limit: number(args.limit, 20, 50) }, true);
      return {
        mode: 'search',
        results: await Promise.all(
          found.map(async (row) => {
            const [chunk] =
              await sql`SELECT text FROM search_chunks WHERE user_id=${identity.userId} AND device_id=${row.device_id} AND key=${row.key} AND tokens @@ plainto_tsquery('simple',${text(args.query)}) LIMIT 1`;
            return {
              id: remoteId(row.device_id, row.key),
              harness: row.item.harness,
              kind: row.item.kind,
              path: row.item.sourcePath,
              modifiedAt: row.item.modifiedAt,
              snippet: text(chunk?.text).slice(0, 500),
              origin: origin(row),
            };
          }),
        ),
      };
    }
    if (name === 'read_session') {
      const row = await read(text(args.filePath));
      if (row.item.kind !== 'session') throw new Error('Expected a session');
      const lines = row.item.content.split('\n'),
        mode = text(args.format) || 'digest';
      let data;
      if (mode === 'events') {
        if (args.includeTools !== undefined) throw new Error('includeTools requires messages format');
        data = pageSessionEvents(
          lines,
          offset(args.offset),
          number(args.limit, 20, 100),
          offset(args.characterOffset),
          typeof args.version === 'string' ? args.version : undefined,
        );
      } else {
        if (args.version !== undefined || args.characterOffset !== undefined)
          throw new Error('Event cursor requires events format');
        if (mode === 'digest') {
          if (args.offset !== undefined || args.limit !== undefined || args.includeTools !== undefined)
            throw new Error('Pagination requires messages or events format');
          data = { ...buildSessionDigest(lines) };
        } else {
          const all = getSessionMessages(lines),
            start = offset(args.offset),
            page = all.slice(start, start + number(args.limit, 20, 100));
          data = {
            total: all.length,
            offset: start,
            returned: page.length,
            messages: page.map((m) => ({
              role: m.role,
              text: m.text,
              ...(args.includeTools
                ? { tools: m.tools.map((t) => (t.summary ? `${t.name}(${t.summary})` : t.name)) }
                : {}),
            })),
          };
        }
      }
      return { result: { mode, data }, origin: origin(row) };
    }
    if (name === 'search_sessions') {
      if (args.after && args.before && String(args.after) > String(args.before))
        throw new Error('after must not be later than before');
      const mode = text(args.mode) || 'ranked';
      if (mode !== 'ranked') return patternSearch(args, mode);
      if (args.role !== undefined || args.ignoreCase !== undefined)
        throw new Error('role and ignoreCase require literal or regex mode');
      const found = await rows({ ...args, limit: number(args.limit, 20, 50) });
      const results = await Promise.all(
        found.map(async (row) => {
          const result = formatted(row);
          if (text(args.query).trim()) {
            const chunks = await sql`SELECT DISTINCT ON(message_index) message_index,role,text FROM search_chunks
            WHERE user_id=${identity.userId} AND device_id=${row.device_id} AND key=${row.key} AND message_index>=0
            AND tokens @@ plainto_tsquery('simple',${text(args.query)}) ORDER BY message_index,chunk LIMIT 3`;
            return {
              ...result,
              messageHits: chunks.map((c: { message_index: number; role: string; text: string }) => ({
                index: c.message_index,
                role: c.role,
                snippet: c.text.slice(0, 500),
              })),
            };
          }
          return result;
        }),
      );
      return { result: { mode, data: { results, count: results.length } } };
    }
    return context(args);
  };
  async function patternSearch(args: Record<string, unknown>, mode: string) {
    if (!text(args.query).trim() || text(args.query).length > 1000)
      throw new Error('Pattern must contain 1 to 1000 characters');
    if (args.errored !== undefined || args.files !== undefined)
      throw new Error('errored and files require ranked mode');
    const limit = number(args.limit, 50, 200);
    const query = text(args.query),
      insensitive = args.ignoreCase !== false;
    // A transaction-local timeout bounds PostgreSQL regular-expression work.
    return sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout='5s'`;
      const params: unknown[] = [identity.userId, query];
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const condition = ["s.item->>'kind'='session'", 'c.user_id=$1', 'c.message_index>=0'];
      if (mode === 'regex') condition.push(`c.text ${insensitive ? '~*' : '~'} $2`);
      else condition.push(insensitive ? 'strpos(lower(c.text),lower($2))>0' : 'strpos(c.text,$2)>0');
      if (args.role) condition.push(`c.role=${bind(args.role)}`);
      if (args.tool) condition.push(`s.item->>'harness'=${bind(args.tool)}`);
      if (args.project) condition.push(`s.item->>'cwd'=${bind(args.project)}`);
      if (args.after) condition.push(`s.projection->>'date'>=${bind(args.after)}`);
      if (args.before) condition.push(`s.projection->>'date'<=${bind(args.before)}`);
      if (args.device) condition.push(`s.device_id=${bind(args.device)}::uuid`);
      if (excludeDevice) condition.push(`s.device_id<>${bind(excludeDevice)}::uuid`);
      const base = `FROM search_messages c JOIN snapshots s USING(user_id,device_id,key) JOIN devices d ON d.id=s.device_id WHERE ${condition.join(' AND ')}`;
      const [counts] = await tx.unsafe(
        `SELECT count(DISTINCT (c.device_id,c.key,c.message_index))::int AS hits,count(DISTINCT(c.device_id,c.key))::int AS sessions ${base}`,
        params,
      );
      const found = await tx.unsafe(
        `SELECT DISTINCT ON(c.device_id,c.key,c.message_index) s.device_id,s.key,s.item-'content' AS item,s.projection,d.name AS device,c.message_index,c.role,c.text ${base} ORDER BY c.device_id,c.key,c.message_index,c.chunk LIMIT ${bind(limit)}`,
        params,
      );
      const hits = found.map((row: Row & { role: string; message_index: number; text: string }) => ({
        ...formatted(row),
        role: row.role,
        msgIndex: row.message_index,
        snippet: row.text.slice(0, 500),
      }));
      return {
        result: {
          mode,
          data: {
            hits,
            totalHits: counts.hits,
            totalSessions: counts.sessions,
            returnedHits: hits.length,
            truncated: counts.hits > hits.length,
          },
        },
      };
    });
  }
  async function context(args: Record<string, unknown>) {
    const mode = text(args.mode) || 'project';
    if (mode === 'project') {
      if (args.startDate !== undefined || args.endDate !== undefined || args.detail !== undefined)
        throw new Error('Dates and detail require activity mode');
      if (!text(args.cwd)) throw new Error('Remote project context requires cwd');
      const found = await rows({
        ...args,
        limit: number(args.limit, 10, 25),
        after: args.days
          ? new Date(Date.now() - number(args.days, 30, 36500) * 86400000).toISOString().slice(0, 10)
          : undefined,
      });
      return {
        result: {
          mode,
          data: {
            repoLabel: text(args.cwd),
            toolFilter: args.tool ?? '',
            recent: found.map((row) => ({
              sessionId: row.item.sessionId,
              tool: row.item.harness,
              branch: row.projection.branch,
              date: row.projection.date,
              messageCount: row.projection.messageCount,
              intent: row.projection.title || row.projection.opening,
              files: row.projection.files.slice(0, 50),
              fileCount: row.projection.files.length,
              opening: row.projection.opening,
              closing: row.projection.closing ?? { user: '', assistant: '' },
              filePath: remoteId(row.device_id, row.key),
              origin: origin(row),
            })),
            headlines: [],
            isEmpty: found.length === 0,
          },
        },
      };
    }
    if (!args.startDate || !args.endDate || String(args.startDate) > String(args.endDate))
      throw new Error('Activity requires chronological startDate and endDate');
    if (args.limit !== undefined || args.days !== undefined || args.worktree !== undefined)
      throw new Error('limit, days and worktree require project mode');
    const found = await rows({ ...args, after: args.startDate, before: args.endDate }, false, true);
    const days = new Map<string, Map<string, Row[]>>(),
      tools: Record<string, number> = {};
    for (const row of found) {
      const date = row.projection.createdAt.slice(0, 10);
      const projects = days.get(date) ?? new Map();
      const group = projects.get(row.item.cwd) ?? [];
      group.push(row);
      projects.set(row.item.cwd, group);
      days.set(date, projects);
      tools[row.item.harness] = (tools[row.item.harness] ?? 0) + 1;
    }
    const groupedDays = await Promise.all(
      [...days].map(async ([date, projects]) => ({
        date,
        sessions: [...projects.values()].reduce((sum, group) => sum + group.length, 0),
        projects: await Promise.all(
          [...projects].map(async ([project, group]) => {
            const selected = [...group]
              .sort((a, b) => b.projection.messageCount - a.projection.messageCount)
              .filter((row) => row.projection.messageCount > (args.detail === 'highlights' ? 3 : 0));
            return {
              project,
              sessions: group.length,
              totalMessages: group.reduce((sum, row) => sum + row.projection.messageCount, 0),
              tools: [...new Set(group.map((row) => row.item.harness))],
              topics: [...new Set(group.map((row) => row.projection.title || row.projection.opening))].slice(0, 10),
              filePaths: group.slice(0, 20).map((row) => remoteId(row.device_id, row.key)),
              truncated:
                group.length > 20 || (args.detail !== undefined && args.detail !== 'compact' && selected.length > 10),
              ...(args.detail === 'full' || args.detail === 'highlights'
                ? {
                    sessionDetails: await Promise.all(
                      selected.slice(0, 10).map(async (row) => ({
                        sessionId: row.item.sessionId,
                        tool: row.item.harness,
                        title: row.projection.title || row.projection.opening,
                        messageCount: row.projection.messageCount,
                        filePath: remoteId(row.device_id, row.key),
                        userMessages: await userMessages(row, args.detail === 'highlights'),
                      })),
                    ),
                  }
                : {}),
            };
          }),
        ),
      })),
    );
    return {
      result: {
        mode,
        data: {
          period: { start: args.startDate, end: args.endDate },
          totalSessions: found.length,
          totalMessages: found.reduce((sum, row) => sum + row.projection.messageCount, 0),
          tools,
          projects: [...new Set(found.map((row) => row.item.cwd))],
          days: groupedDays,
          truncated: groupedDays.some((day) => day.projects.some((project) => project.truncated)),
        },
      },
    };
  }

  async function userMessages(row: Row, highlights: boolean): Promise<string[]> {
    const first = await sql`SELECT message_index,left(text,${highlights ? 300 : 500}) AS text FROM search_messages
      WHERE user_id=${identity.userId} AND device_id=${row.device_id} AND key=${row.key} AND role='user'
      ORDER BY message_index LIMIT ${highlights ? 1 : 20}`;
    if (highlights) {
      const [last] = await sql`SELECT message_index,left(text,300) AS text FROM search_messages
        WHERE user_id=${identity.userId} AND device_id=${row.device_id} AND key=${row.key} AND role='user'
        ORDER BY message_index DESC LIMIT 1`;
      if (last && last.message_index !== first[0]?.message_index) first.push(last);
    }
    return first.map((message: { text: string }) => message.text);
  }
}
