import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { getHome, getDataDir } from '@pacifico/core/paths';
import { z } from 'zod';
import { installedExecutable } from './executable';

export const DAEMON_LABEL = 'com.emersoftware.pacifico';
export const DAEMON_INTERVAL_SECONDS = 30;
const OWNERSHIP = '<!-- Managed by Pacifico -->';
const runSchema = z.object({
  completedAt: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  total: z.number().optional(),
  updated: z.number().optional(),
  error: z.string().optional(),
});

function plistPath(): string {
  return join(getHome(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}

function statePath(): string {
  return join(getDataDir(), 'daemon-state.json');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * launchd owns scheduling and prevents overlapping firings. The worker imports
 * once and exits; there is no resident polling process or continuously growing log.
 * Only known source/config overrides are persisted, never the entire shell env.
 */
export function renderLaunchAgent(program: string[], environment: NodeJS.ProcessEnv): string {
  const pathKeys = [
    'SESSIONS_HOME',
    'SESSIONS_DATA_DIR',
    'SESSIONS_CACHE_DIR',
    'SESSIONS_ARCHIVE_DIR',
    'SESSIONS_CLAUDE_DIR',
    'SESSIONS_CODEX_DIR',
    'SESSIONS_PI_DIR',
    'SESSIONS_OPENCODE_DB',
    'PI_CODING_AGENT_SESSION_DIR',
    'PI_CODING_AGENT_DIR',
  ];
  const values: Array<[string, string]> = [];
  for (const key of pathKeys) {
    const value = environment[key];
    if (value) values.push([key, resolve(value)]);
  }
  if (environment.PATH) values.push(['PATH', environment.PATH]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${OWNERSHIP}
<plist version="1.0"><dict>
<key>Label</key><string>${DAEMON_LABEL}</string>
<key>ProgramArguments</key><array>${program.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(resolve(getHome()))}</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${DAEMON_INTERVAL_SECONDS}</integer>
<key>ProcessType</key><string>Background</string>
<key>ExitTimeOut</key><integer>60</integer>
<key>EnvironmentVariables</key><dict>${values.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
</dict></plist>
`;
}

/** Perform one import, recording a bounded last-run result even on failure. */
export async function runDaemonPass(): Promise<void> {
  const started = Date.now();
  const { refreshIndex, closeDb } = await import('@pacifico/core/cache');
  let result: z.infer<typeof runSchema>;
  try {
    const refreshed = await refreshIndex();
    if (refreshed.archiveWarning)
      throw new Error(
        'Index refreshed, but some transcripts could not be archived. Check archive storage permissions and free space.',
      );
    result = { completedAt: new Date().toISOString(), ok: true, durationMs: Date.now() - started, ...refreshed };
  } catch (error) {
    result = {
      completedAt: new Date().toISOString(),
      ok: false,
      durationMs: Date.now() - started,
      error: String(error).slice(0, 2000),
    };
  } finally {
    closeDb();
  }
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
  if (!result.ok) throw new Error(result.error);
}

function target(): string {
  if (process.platform !== 'darwin' || !process.getuid)
    throw new Error('Background service management currently requires macOS.');
  return `gui/${process.getuid()}/${DAEMON_LABEL}`;
}

function launchctl(...args: string[]) {
  return Bun.spawnSync(['/bin/launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
}

function loaded(): boolean {
  return launchctl('print', target()).exitCode === 0;
}

function requireSuccess(result: ReturnType<typeof launchctl>): void {
  if (result.exitCode !== 0)
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `launchctl exited ${result.exitCode}`);
}

/** Ensure the scheduled job is stopped and no longer starts at login; keep all data. */
export function stopDaemon(): void {
  const path = plistPath();
  if (!existsSync(path)) return;
  if (!readFileSync(path, 'utf8').includes(OWNERSHIP))
    throw new Error(`Refusing to remove a user-owned service: ${path}`);
  if (loaded()) requireSuccess(launchctl('bootout', target()));
  rmSync(path);
}

function startDaemon(): void {
  const service = target();
  const path = plistPath();
  const program =
    basename(process.execPath) === 'bun'
      ? [process.execPath, resolve(Bun.main)]
      : [installedExecutable(process.execPath)];
  const content = renderLaunchAgent([...program, 'daemon', 'run'], process.env);
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (previous && !previous.includes(OWNERSHIP)) throw new Error(`Refusing to overwrite a user-owned service: ${path}`);
  const active = loaded();
  if (previous === content && active) return;
  if (active) requireSuccess(launchctl('bootout', service));
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  requireSuccess(launchctl('enable', service));
  requireSuccess(launchctl('bootstrap', service.slice(0, service.lastIndexOf('/')), path));
}

export async function runDaemonCommand(args: string[]): Promise<void> {
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['start', 'stop', 'status', 'run'].includes(action)) {
    throw new Error('Usage: pacifico daemon [start|stop|status|run]');
  }
  if (action === 'run') return runDaemonPass();
  if (action === 'start') {
    startDaemon();
    process.stdout.write(`Pacifico background import enabled, every ${DAEMON_INTERVAL_SECONDS}s.\n`);
  } else if (action === 'stop') {
    stopDaemon();
    process.stdout.write('Pacifico background import stopped; archive and memories preserved.\n');
  } else {
    let lastRun: z.infer<typeof runSchema> | null = null;
    if (existsSync(statePath())) {
      try {
        lastRun = runSchema.parse(JSON.parse(readFileSync(statePath(), 'utf8')));
      } catch {}
    }
    process.stdout.write(
      JSON.stringify(
        {
          supported: process.platform === 'darwin',
          installed: existsSync(plistPath()),
          scheduled: process.platform === 'darwin' && loaded(),
          intervalSeconds: DAEMON_INTERVAL_SECONDS,
          lastRun,
        },
        null,
        2,
      ) + '\n',
    );
  }
}
