import { isAbsolute } from 'node:path';
import { Database } from 'bun:sqlite';
import type { SourceEvent } from './records';

interface NativeObject {
  [key: string]: unknown;
}

export interface CursorIdeSession {
  id: string;
  metadata: NativeObject;
  cwd: string;
  events: SourceEvent[];
  incomplete: boolean;
}

function object(value: unknown): NativeObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as NativeObject) : null;
}

function decode(value: string | Uint8Array): NativeObject | null {
  try {
    return object(JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value)));
  } catch {
    return null;
  }
}

function capabilityTools(metadata: NativeObject): Map<string, NativeObject> {
  const tools = new Map<string, NativeObject>();
  if (!Array.isArray(metadata.capabilities)) return tools;
  for (const value of metadata.capabilities) {
    const capability = object(value);
    if (capability?.type !== 15) continue;
    const valueMap = object(capability.data)?.bubbleDataMap;
    const entries = typeof valueMap === 'string' ? decode(valueMap) : object(valueMap);
    if (!entries) continue;
    for (const [id, value] of Object.entries(entries)) {
      const tool = object(value);
      if (tool) tools.set(id, tool);
    }
  }
  return tools;
}

function event(raw: NativeObject, id: string, capabilityTool?: NativeObject): SourceEvent {
  const tool = object(raw.toolFormerData) ?? capabilityTool;
  const toolCalls: SourceEvent['toolCalls'] = [];
  if (tool && typeof tool.name === 'string') {
    let input: unknown = tool.rawArgs;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        /* Preserve incomplete arguments verbatim. */
      }
    }
    toolCalls.push({ name: tool.name, input, ...(typeof tool.toolCallId === 'string' ? { id: tool.toolCallId } : {}) });
  }
  const text = typeof raw.text === 'string' ? raw.text : typeof raw.rawText === 'string' ? raw.rawText : '';
  const nativeThinking = object(raw.thinking)?.text;
  const thinking = typeof nativeThinking === 'string' ? nativeThinking : raw.isThought === true ? text : undefined;
  const timestamp = raw.timestamp;
  const date = typeof timestamp === 'number' ? new Date(timestamp) : null;
  return {
    id,
    role: raw.type === 1 ? 'user' : raw.type === 2 ? 'assistant' : 'unknown',
    text: raw.isThought === true ? '' : text,
    ...(thinking !== undefined ? { thinking } : {}),
    ...(typeof timestamp === 'string'
      ? { timestamp }
      : date && Number.isFinite(date.getTime())
        ? { timestamp: date.toISOString() }
        : {}),
    toolCalls,
    truncated: false,
    ...(capabilityTool ? { variants: [{ source: 'cursor-capability', record: capabilityTool }] } : {}),
    raw,
  };
}

function legacySessions(db: Database, selected?: string): CursorIdeSession[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'ItemTable'").get()) return [];
  const row = db
    .query<{ value: string | Uint8Array }, []>(
      "SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'",
    )
    .get();
  const data = row && decode(row.value);
  const sessions = data && (data.chatSessions ?? data.tabs);
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((value) => {
    const metadata = object(value);
    if (!metadata || typeof metadata.id !== 'string') return [];
    const id = `legacy:${metadata.id}`;
    if (selected !== undefined && selected !== id) return [];
    const messages = metadata.messages ?? metadata.bubbles;
    const session: CursorIdeSession = { id, metadata, cwd: '', events: [], incomplete: !Array.isArray(messages) };
    if (!Array.isArray(messages)) return [session];
    messages.forEach((value, index) => {
      const raw = object(value);
      if (!raw) {
        session.incomplete = true;
        return;
      }
      const role = raw.role ?? raw.type;
      const parsed = event(
        {
          ...raw,
          type: role === 'user' ? 1 : role === 'assistant' || role === 'ai' ? 2 : 0,
          text: typeof raw.content === 'string' ? raw.content : raw.text,
          timestamp: raw.timestamp ?? raw.createdAt,
        },
        typeof raw.id === 'string' ? raw.id : `message:${index}`,
      );
      session.events.push({ ...parsed, raw });
    });
    return [session];
  });
}

function workspaceSessions(db: Database, selected?: string): CursorIdeSession[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'ItemTable'").get()) return [];
  const row = db
    .query<{ value: string | Uint8Array }, []>("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
    .get();
  const composers = row && decode(row.value)?.allComposers;
  if (!Array.isArray(composers)) return [];
  return composers.flatMap((value) => {
    const metadata = object(value);
    if (!metadata || typeof metadata.composerId !== 'string') return [];
    const id = `workspace:${metadata.composerId}`;
    if (selected !== undefined && selected !== id) return [];
    const session: CursorIdeSession = {
      id,
      metadata,
      cwd: '',
      events: [],
      incomplete: !Array.isArray(metadata.conversation),
    };
    if (!Array.isArray(metadata.conversation)) return [session];
    const tools = capabilityTools(metadata);
    metadata.conversation.forEach((value, index) => {
      const raw = object(value);
      if (!raw) {
        session.incomplete = true;
        return;
      }
      const eventId = typeof raw.bubbleId === 'string' ? raw.bubbleId : `message:${index}`;
      session.events.push(event(raw, eventId, raw.capabilityType === 15 ? tools.get(eventId) : undefined));
    });
    return [session];
  });
}

/** Reads composer metadata and bubbles from one consistent, read-only snapshot. */
export function readCursorIde(path: string, sessionId?: string): CursorIdeSession[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      const legacy = [...legacySessions(db, sessionId), ...workspaceSessions(db, sessionId)];
      if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'cursorDiskKV'").get()) return legacy;
      const rows =
        sessionId === undefined
          ? db
              .query<{ key: string; value: string | Uint8Array }, []>(
                "SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'",
              )
              .all()
          : db
              .query<{ key: string; value: string | Uint8Array }, [string]>(
                'SELECT key, value FROM cursorDiskKV WHERE key = ?',
              )
              .all(`composerData:${sessionId}`);
      const lookup = db.query<{ value: string | Uint8Array }, [string]>('SELECT value FROM cursorDiskKV WHERE key = ?');
      return [
        ...legacy,
        ...rows.flatMap(({ key, value }) => {
          const metadata = decode(value);
          if (!metadata) return [];
          const id = key.slice('composerData:'.length);
          const headers = metadata.fullConversationHeadersOnly ?? metadata.conversationHeaders ?? metadata.conversation;
          const session: CursorIdeSession = { id, metadata, cwd: '', events: [], incomplete: !Array.isArray(headers) };
          if (!Array.isArray(headers)) return [session];
          const tools = capabilityTools(metadata);
          const seen = new Set<string>();
          for (const header of headers) {
            const reference = object(header);
            const bubbleId = reference?.bubbleId;
            if (typeof bubbleId !== 'string') {
              session.incomplete = true;
              continue;
            }
            if (seen.has(bubbleId)) continue;
            seen.add(bubbleId);
            const stored = lookup.get(`bubbleId:${id}:${bubbleId}`);
            const raw = stored
              ? decode(stored.value)
              : reference &&
                  ('text' in reference ||
                    'rawText' in reference ||
                    'thinking' in reference ||
                    reference.capabilityType === 15)
                ? reference
                : null;
            if (raw)
              session.events.push(event(raw, bubbleId, raw.capabilityType === 15 ? tools.get(bubbleId) : undefined));
            else session.incomplete = true;
          }
          const workspaces = new Set(
            session.events
              .map((e) => e.raw.workspaceProjectDir)
              .filter((path): path is string => typeof path === 'string' && isAbsolute(path)),
          );
          session.cwd = workspaces.size === 1 ? [...workspaces][0]! : '';
          return [session];
        }),
      ];
    })();
  } finally {
    db.close();
  }
}

/** A virtual path identifies one composer within its native database. */
export function cursorIdeLocation(path: string): { database: string; id: string } | null {
  const match = path.match(/^(.*\/state\.vscdb)\/([^/]+)$/);
  if (!match) return null;
  try {
    return { database: match[1]!, id: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

/** Modern discovery reads keys; legacy sessions share one JSON container. */
export function listCursorIdeSessions(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    const legacy = [...legacySessions(db), ...workspaceSessions(db)].map((session) => session.id);
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'cursorDiskKV'").get()) return legacy;
    return [
      ...legacy,
      ...db
        .query<{ key: string }, []>(
          "SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' ORDER BY key",
        )
        .all()
        .map(({ key }) => key.slice('composerData:'.length)),
    ];
  } finally {
    db.close();
  }
}

/** Tests the selected composer, not merely the existence of its shared database. */
export function cursorIdeSessionExists(path: string): boolean {
  const location = cursorIdeLocation(path);
  if (!location) return false;
  let db: Database | undefined;
  try {
    db = new Database(location.database, { readonly: true });
    if (location.id.startsWith('workspace:')) return workspaceSessions(db, location.id).length > 0;
    if (location.id.startsWith('legacy:')) return legacySessions(db, location.id).length > 0;
    return db.query('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`composerData:${location.id}`) !== null;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
