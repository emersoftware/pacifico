import { showUsage } from './usage-view';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { refreshUsage, queryUsage, importUsageExport, PERIODS } from '@pacifico/core/usage';

export async function runUsage(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      cached: { type: 'boolean' },
      plain: { type: 'boolean' },
      project: { type: 'string' },
      harness: { type: 'string' },
      model: { type: 'string' },
      task: { type: 'string' },
      period: { type: 'string' },
      group: { type: 'string' },
      timezone: { type: 'string' },
      limit: { type: 'string' },
      file: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'pacifico usage [--json] [--cached] [--plain] [--project PATH] [--harness NAME] [--model MODEL] [--task SESSION]\n  [--period today|7d|30d|365d|all] [--group day|project|harness|model|task] [--timezone IANA] [--limit N]\npacifico usage import --harness cursor|antigravity --file EXPORT [--project PATH]\nB = 1,000,000,000 tokens. Month/year windows are rolling 30/365 calendar days.\n',
    );
    return;
  }
  if (positionals[0] === 'import' && positionals.length === 1) {
    const harness = z.enum(['cursor', 'antigravity']).parse(values.harness);
    if (!values.file) throw new Error('import requires --file EXPORT.');
    process.stdout.write(
      JSON.stringify({ imported: importUsageExport(harness, readFileSync(values.file, 'utf8'), values.project) }) +
        '\n',
    );
    return;
  }
  if (positionals.length) throw new Error('Unknown usage command.');
  const period = z.enum(PERIODS).optional().parse(values.period);
  const group = z.enum(['day', 'project', 'harness', 'model', 'task']).optional().parse(values.group);
  const harness = z
    .enum(['claude', 'claude-code', 'codex', 'opencode', 'cursor', 'antigravity'])
    .optional()
    .parse(values.harness);
  if (!values.cached) await refreshUsage();
  const options = {
    ...values,
    harness,
    group,
    period,
    limit: values.limit === undefined ? undefined : Number(values.limit),
  };
  const result = values.json ? queryUsage(options) : undefined;
  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else await showUsage(options, !!process.stdin.isTTY && !!process.stdout.isTTY && !values.plain);
}
