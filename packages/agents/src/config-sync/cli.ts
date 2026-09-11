import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HARNESS_IDS } from './formats';
import { syncConfiguration } from './index';

export async function runConfigSync(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      project: { type: 'string' },
      kind: { type: 'string' },
      name: { type: 'string', multiple: true },
      apply: { type: 'boolean' },
      help: { type: 'boolean' },
      'skills-dir': { type: 'string' },
      'config-file': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'pacifico sync --from HARNESS --to HARNESS[,HARNESS] [--project PATH] [--kind skills|mcp] [--name NAME] [--apply]\nHarnesses: ' +
        HARNESS_IDS.join(', ') +
        '\nDefaults to a read-only preview of global configuration. Conflicts prevent application.\n' +
        'Plugin sources: --skills-dir DIRECTORY --kind skills, or --config-file FILE --kind mcp.\n',
    );
    return;
  }
  const from = z.enum(HARNESS_IDS).parse(values.from);
  const to = z.array(z.enum(HARNESS_IDS)).min(1).parse(values.to?.split(','));
  const kind = z.enum(['skills', 'mcp']).optional().parse(values.kind);
  const result = syncConfiguration({
    from,
    to,
    kind,
    project: values.project,
    names: values.name,
    apply: values.apply,
    skillsDirectory: values['skills-dir'],
    configFile: values['config-file'],
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (values.apply && (!result.applied || result.items.some((item) => item.status === 'unsupported')))
    process.exitCode = 1;
}
