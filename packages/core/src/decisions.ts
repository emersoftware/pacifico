import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { getDataDir } from './paths';
import { getDb } from './storage/index';
import { readSessionLines } from './session-io';
import { extractMessages } from './parser';
import { resolveRepo, cwdUnder } from './repo';
import type { Tool } from './types';

export const DecisionInput = z
  .object({
    project: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    decision: z.string().trim().min(1).max(8000),
    rationale: z.string().max(8000).default(''),
    decidedAt: z.iso.date(),
    supersedes: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    evidence: z
      .array(
        z
          .object({
            filePath: z.string().min(1),
            messageIndex: z.number().int().min(0),
            quote: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export interface Decision {
  id: string;
  project: string;
  title: string;
  decision: string;
  rationale: string;
  decidedAt: string;
  recordedAt: string;
  supersedes?: string;
  status: 'accepted' | 'superseded';
  evidence: Array<{
    filePath: string;
    messageIndex: number;
    quote: string;
    role: 'user' | 'assistant';
    genuine: boolean;
    sessionId: string;
    harness: Tool;
    messageHash: string;
  }>;
}

export function decisionProject(path: string): string {
  return resolveRepo(path)?.container ?? resolve(path);
}

function openDecisions(): Database {
  mkdirSync(getDataDir(), { recursive: true });
  const db = new Database(join(getDataDir(), 'decisions.sqlite'));
  chmodSync(join(getDataDir(), 'decisions.sqlite'), 0o600);
  db.run('PRAGMA busy_timeout=5000');
  db.run('PRAGMA journal_mode=WAL');
  db.run(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, decided_at TEXT NOT NULL,
    supersedes TEXT UNIQUE REFERENCES decisions(id), body TEXT NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS decisions_project ON decisions(project, decided_at)');
  return db;
}

/** A decision is an agent-authored interpretation with verified native evidence. */
export function saveDecision(value: unknown): Decision {
  const input = DecisionInput.parse(value);
  const project = decisionProject(input.project);
  const evidence: Decision['evidence'] = input.evidence.map((citation) => {
    const source = getDb()
      .query<{ session_id: string; tool: Tool; cwd: string }, [string]>(
        'SELECT session_id, tool, cwd FROM sessions WHERE file_path = ?',
      )
      .get(citation.filePath);
    if (!source || !(cwdUnder(source.cwd, project) || decisionProject(source.cwd) === project))
      throw new Error('Evidence must reference an indexed session in this project.');
    const message = extractMessages(readSessionLines(citation.filePath, source.tool)).find(
      (message) => message.index === citation.messageIndex,
    );
    if (!message || !message.text.includes(citation.quote))
      throw new Error('Evidence quote does not match the referenced message. Read the session again.');
    return {
      ...citation,
      role: message.role,
      genuine: message.genuine,
      sessionId: source.session_id,
      harness: source.tool,
      messageHash: createHash('sha256').update(message.text).digest('hex'),
    };
  });
  if (!evidence.some((item) => item.role === 'user' && item.genuine))
    throw new Error('An accepted decision needs evidence from a user message.');
  const content = { ...input, project, evidence };
  const id = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 32);
  const db = openDecisions();
  try {
    return db.transaction(() => {
      const existing = db.query<{ body: string }, [string]>('SELECT body FROM decisions WHERE id = ?').get(id);
      if (existing) return JSON.parse(existing.body) as Decision;
      if (input.supersedes) {
        const previous = db
          .query<{ project: string; decided_at: string }, [string]>(
            'SELECT project, decided_at FROM decisions WHERE id = ?',
          )
          .get(input.supersedes);
        if (!previous || previous.project !== project || previous.decided_at > input.decidedAt)
          throw new Error('A superseded decision must belong to this project and precede its replacement.');
      }
      const record: Decision = { ...content, id, status: 'accepted', recordedAt: new Date().toISOString() };
      db.run('INSERT INTO decisions VALUES (?, ?, ?, ?, ?)', [
        id,
        project,
        input.decidedAt,
        input.supersedes ?? null,
        JSON.stringify(record),
      ]);
      return record;
    })();
  } finally {
    db.close();
  }
}

export function listDecisions(
  projectPath: string,
  options: { query?: string; limit?: number; offset?: number } = {},
): Decision[] {
  const project = decisionProject(projectPath);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.limit ?? 25);
  const offset = z
    .number()
    .int()
    .min(0)
    .parse(options.offset ?? 0);
  const databasePath = join(getDataDir(), 'decisions.sqlite');
  if (!existsSync(databasePath)) return [];
  const db = new Database(databasePath, { readonly: true });
  try {
    const rows = db
      .query<{ body: string; replaced: number }, [string, string, number, number]>(
        `
      SELECT d.body, EXISTS(SELECT 1 FROM decisions newer WHERE newer.supersedes = d.id) AS replaced
      FROM decisions d WHERE project = ? AND instr(lower(d.body), lower(?)) > 0
      ORDER BY decided_at DESC, id LIMIT ? OFFSET ?
    `,
      )
      .all(project, options.query ?? '', limit, offset);
    return rows.map(({ body, replaced }) => ({ ...JSON.parse(body), status: replaced ? 'superseded' : 'accepted' }));
  } finally {
    db.close();
  }
}

/** Export is explicit and never replaces an existing user file. */
export function exportDecisions(project: string, directory: string): string[] {
  const paths: string[] = [];
  mkdirSync(directory, { recursive: true });
  for (let offset = 0; ; offset += 100) {
    const records = listDecisions(project, { limit: 100, offset });
    for (const record of records) {
      const path = join(directory, `${record.decidedAt}-${record.id}.md`);
      const text =
        `# ${record.title}\n\nStatus: ${record.status}\nDate: ${record.decidedAt}\nID: ${record.id}\nProject: ${record.project}\n` +
        (record.supersedes ? `Supersedes: ${record.supersedes}\n` : '') +
        `\n## Decision\n\n${record.decision}\n\n## Rationale\n\n${record.rationale}\n\n## Evidence\n\n` +
        record.evidence
          .map(
            (item) =>
              `- ${item.harness}, session ${item.sessionId}, message ${item.messageIndex} (${item.role})\n  Source: ${item.filePath}\n  Message SHA-256: ${item.messageHash}\n\n${item.quote
                .split('\n')
                .map((line) => '> ' + line)
                .join('\n')}\n`,
          )
          .join('\n');
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      paths.push(path);
    }
    if (records.length < 100) return paths;
  }
}
