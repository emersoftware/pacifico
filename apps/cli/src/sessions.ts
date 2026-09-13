import { resolve } from 'node:path';
import { callControl, ensureControl } from '@pacifico/agents/sessions/connection';
import type { ActiveSession, RequestResult } from '@pacifico/agents/sessions/service';
import { currentProgram } from '@pacifico/agents/executable';

export async function runSessions(command: string, argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`pacifico start <claude|codex> <message> [--cwd <directory>] [--write] [--wait] [--json]
pacifico send <session> <message> [--wait] [--json]
pacifico result <request> [--wait] [--json]
pacifico sessions [--json]
pacifico sessions close <session>
pacifico sessions stop

Start creates a native session and keeps its process open. Send uses that same
connected session. Busy or disconnected sessions reject the message.
Read access is the default; --write allows edits when creating a session.
--wait waits up to 60 seconds. The request continues if the wait expires.
Use pacifico result to read it later. Reviews are ordinary task messages.
Send also connects to external Codex App Servers (optional --socket <path>)
and Claude sessions that enabled the Pacifico channel. See docs/SESSIONS.md.
`);
    return;
  }
  let wait = false,
    json = false,
    write = false;
  let socket: string | undefined;
  let cwd = process.cwd();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--socket' && command === 'send') {
      if (!argv[i + 1]) throw new Error('--socket requires a path.');
      socket = resolve(argv[++i]!);
    } else if (arg === '--wait') wait = true;
    else if (arg === '--json') json = true;
    else if (arg === '--write' && command === 'start') write = true;
    else if (arg === '--cwd' && command === 'start') {
      if (!argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error('--cwd requires a directory.');
      cwd = resolve(argv[++i]!);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else args.push(arg);
  }
  let request;
  if (command === 'start') {
    const harness = args[0];
    if (!['claude', 'codex'].includes(harness ?? '') || args.length !== 2)
      throw new Error('Usage: pacifico start <claude|codex> "message"');
    request = {
      method: 'start' as const,
      harness: harness as 'claude' | 'codex',
      message: args[1]!,
      project: cwd,
      write,
    };
  } else if (command === 'send') {
    if (args.length !== 2) throw new Error('Usage: pacifico send <session> "message"');
    request = { method: 'send' as const, session: args[0]!, message: args[1]!, socket };
  } else if (command === 'result') {
    if (args.length !== 1) throw new Error('Usage: pacifico result <request>');
    request = { method: 'result' as const, request: args[0]! };
  } else if (args[0] === 'stop' && args.length === 1) {
    request = { method: 'stop' as const };
  } else if (args[0] === 'close' && args.length === 2) {
    request = { method: 'close' as const, session: args[1]! };
  } else {
    if (args.length) throw new Error('Usage: pacifico sessions [close <session>]');
    request = { method: 'list' as const };
  }
  await ensureControl(currentProgram());
  let result = await callControl(request);
  if (request.method === 'list') {
    const sessions = result as ActiveSession[];
    process.stdout.write(
      json
        ? JSON.stringify(sessions) + '\n'
        : sessions.length
          ? sessions.map((s) => `${s.session}  ${s.status}  ${s.project}`).join('\n') + '\n'
          : 'No connected sessions. Use pacifico start.\n',
    );
    return;
  }
  if (request.method === 'close' || request.method === 'stop') {
    process.stdout.write(
      json ? JSON.stringify(result) + '\n' : 'Session disconnected. Its native history is preserved.\n',
    );
    return;
  }
  const deadline = Date.now() + 60000;
  while (wait && result.status === 'running' && Date.now() < deadline) {
    await Bun.sleep(250);
    result = await callControl({ method: 'result', request: result.request });
  }
  const receipt = result as RequestResult;
  if (json) process.stdout.write(JSON.stringify(receipt) + '\n');
  else {
    process.stdout.write(`${receipt.status} ${receipt.request} → ${receipt.session}\n`);
    if (receipt.text) process.stdout.write(receipt.text + '\n');
    if (receipt.truncated)
      process.stderr.write('Response excerpt: full output is preserved in the request store and native transcript.\n');
    if (receipt.error) process.stderr.write(receipt.error + '\n');
  }
  if (receipt.status === 'failed' || receipt.status === 'unknown') process.exitCode = 1;
}
