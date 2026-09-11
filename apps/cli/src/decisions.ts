import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { saveDecision, listDecisions, exportDecisions } from '@pacifico/core/decisions';

export async function runDecisions(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      file: { type: 'string' },
      out: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'pacifico decisions list [--project PATH] [--query TEXT] [--limit N] [--offset N]\npacifico decisions save --file JSON\npacifico decisions export --project PATH --out DIRECTORY\n',
    );
    return;
  }
  const action = positionals[0] ?? 'list';
  if (positionals.length > 1) throw new Error('Unexpected decisions arguments.');
  let result: unknown;
  if (action === 'save') {
    if (!values.file) throw new Error('save requires --file with a decision JSON object.');
    result = saveDecision(JSON.parse(readFileSync(values.file, 'utf8')));
  } else if (action === 'list') {
    result = listDecisions(values.project ?? process.cwd(), {
      query: values.query,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      offset: values.offset === undefined ? undefined : Number(values.offset),
    });
  } else if (action === 'export') {
    if (!values.out) throw new Error('export requires --out DIRECTORY.');
    result = { files: exportDecisions(values.project ?? process.cwd(), values.out) };
  } else throw new Error(`Unknown decisions action: ${action}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
