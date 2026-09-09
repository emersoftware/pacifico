import { connectRemote, disconnectRemote, remoteConfig } from '@pacifico/core/sync/client';
import { syncArchive } from '@pacifico/core/sync/upload';
import { refreshIndex, closeDb } from '@pacifico/core/cache';
import { callRemoteTool } from './remote';
import { parseArgs } from 'node:util';
import type { ToolName } from '@pacifico/core/sync/protocol';

const help = `Usage: pacifico remote <command>

  connect <endpoint> --token-stdin [--allow-http]
  disconnect | status | sync
  search <query> [--mode ranked|literal|regex] [--tool NAME] [--project PATH] [--limit N]
  read <id> [--format digest|messages|events] [--offset N] [--limit N]
  context [PATH] [--days N] [--limit N]
  context --mode activity --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--detail compact|highlights|full]
  documents <query> [--limit N]
  documents --id <id> [--offset N] [--limit N]

Search and context also accept --device UUID and --tool NAME.
Search accepts --after, --before, --role and --case-sensitive.
Message reads accept --include-tools. Event reads accept --character-offset and --version.
Queries print JSON to stdout; failures print to stderr and exit with status 1.`;

const queries: Record<string, { tool: ToolName; positional: string; flags: string[] }> = {
  search: {
    tool: 'search_sessions',
    positional: 'query',
    flags: ['mode', 'tool', 'project', 'limit', 'device', 'after', 'before', 'role', 'case-sensitive'],
  },
  read: {
    tool: 'read_session',
    positional: 'filePath',
    flags: ['format', 'offset', 'limit', 'include-tools', 'character-offset', 'version'],
  },
  context: {
    tool: 'get_context',
    positional: 'cwd',
    flags: ['mode', 'cwd', 'days', 'limit', 'tool', 'device', 'start-date', 'end-date', 'detail'],
  },
  documents: { tool: 'native_documents', positional: 'query', flags: ['id', 'offset', 'limit', 'device'] },
};

export async function runRemoteCommand(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || rest.includes('--help')) {
    console.log(help);
    return;
  }
  if (command === 'connect') {
    const endpoint = rest[0];
    if (!endpoint || !rest.includes('--token-stdin'))
      throw new Error('Usage: pacifico remote connect <endpoint> --token-stdin [--allow-http]');
    const token = (await Bun.stdin.text()).trim();
    const identity = await connectRemote(endpoint, token, rest.includes('--allow-http'));
    console.log(JSON.stringify({ connected: true, ...identity }));
    return;
  }
  if (command === 'disconnect') {
    disconnectRemote();
    console.log('Remote disconnected. Local and server archives retained.');
    return;
  }
  if (command === 'status') {
    const config = remoteConfig();
    console.log(JSON.stringify(config ? { endpoint: config.endpoint, ...config.identity } : { connected: false }));
    return;
  }
  if (command === 'sync') {
    try {
      await refreshIndex();
      console.log(JSON.stringify(await syncArchive()));
    } finally {
      closeDb();
    }
    return;
  }
  const query = queries[command];
  if (!query) throw new Error(help);
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const flag of query.flags)
    options[flag] = { type: ['include-tools', 'case-sensitive'].includes(flag) ? 'boolean' : 'string' };
  const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  const input: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(values)) {
    const key = flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (['offset', 'limit', 'days', 'character-offset'].includes(flag)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (flag.includes('offset') ? 0 : 1))
        throw new Error(`--${flag} requires ${flag.includes('offset') ? 'a nonnegative' : 'a positive'} integer`);
      input[key] = number;
    } else if (flag === 'case-sensitive') input.ignoreCase = !value;
    else input[key] = value;
  }
  if (positionals.length) {
    if (query.positional !== 'query' && positionals.length !== 1)
      throw new Error(`${command} accepts one ${query.positional === 'cwd' ? 'path' : 'identifier'}`);
    if (input[query.positional] !== undefined) throw new Error(`Specify ${query.positional} only once`);
    input[query.positional] = positionals.join(' ');
  }
  if (command === 'read' && !input.filePath) throw new Error('Usage: pacifico remote read <id>');
  if (command === 'documents') input.mode = input.id ? 'read' : 'search';
  const config = remoteConfig();
  if (!config) throw new Error('No remote configured. Run pacifico remote connect.');
  const result = await callRemoteTool(config, query.tool, input);
  if (result.isError) throw new Error(result.content.map((entry) => entry.text).join('\n'));
  console.log(JSON.stringify(result.structuredContent));
}
