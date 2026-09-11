import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { resolveSessionFile } from '@pacifico/core/cache';
import { extractMessages } from '@pacifico/core/parser';
import { readSessionLines } from '@pacifico/core/session-io';
import { getDb } from '@pacifico/core/storage/index';

export async function runRead(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      offset: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write('pacifico read SESSION_ID_OR_PATH [--json] [--offset N] [--limit N]\n');
    return;
  }
  if (positionals.length !== 1) throw new Error('read requires a session ID or file path.');
  const target = positionals[0]!;
  const indexed = getDb().query('SELECT 1 FROM sessions WHERE file_path = ?').get(target);
  const path = existsSync(target) || indexed ? target : await resolveSessionFile(target);
  if (!path) throw new Error('Session not found.');
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .parse(values.offset ?? 0);
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(values.limit ?? 10);
  const all = extractMessages(readSessionLines(path));
  const messages = all.slice(offset, offset + limit).map(({ index, role, text }) => ({ index, role, text }));
  process.stdout.write(JSON.stringify({ filePath: path, total: all.length, offset, messages }, null, 2) + '\n');
}
