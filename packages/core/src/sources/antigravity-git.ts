import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const paths = ['.system_generated/logs/transcript.jsonl', '.system_generated/logs/transcript_full.jsonl'];

function repository(transcript: string): string | null {
  const root = dirname(dirname(dirname(transcript)));
  return existsSync(join(root, '.git')) ? root : null;
}

function git(root: string, args: string[]): string | null {
  const environment: Record<string, string | undefined> = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete environment[key];
  }
  const result = spawnSync('git', ['--no-replace-objects', '-C', root, ...args], {
    env: environment,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout;
}

function revisions(root: string): string[] {
  const output = git(root, ['log', '--all', '--reverse', '--format=%H', '--', ...paths]);
  if (output === null) throw new Error('Cannot read Antigravity Git history');
  return output
    .trim()
    .split('\n')
    .filter((line) => /^[0-9a-f]{40,64}$/.test(line));
}

/** Detect history changes independently of the current transcript's filesystem dates. */
export function antigravityGitVersion(transcript: string): number | null {
  const root = repository(transcript);
  if (!root) return null;
  const commits = revisions(root);
  if (!commits.length) return null;
  return Number.parseInt(createHash('sha256').update(commits.join('\n')).digest('hex').slice(0, 12), 16);
}

/** Reads committed native logs without checkout, repair, or writes to the harness repository. */
export function readAntigravityGit(transcript: string): { source: string; text: string }[] {
  const root = repository(transcript);
  if (!root) return [];
  const snapshots: { source: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const commit of revisions(root)) {
    const tree = git(root, ['ls-tree', '-z', commit, '--', ...paths]);
    if (tree === null) throw new Error('Cannot read Antigravity Git tree');
    for (const entry of tree.split('\0')) {
      const match = entry.match(/^100[0-7]{3} blob ([0-9a-f]{40,64})\t(.+)$/);
      if (!match || !paths.includes(match[2]!)) continue;
      const [, hash, path] = match;
      if (seen.has(hash!)) continue;
      const text = git(root, ['cat-file', 'blob', hash!]);
      if (text === null) throw new Error('Cannot read Antigravity Git blob');
      seen.add(hash!);
      snapshots.push({ source: `git:${commit}:${path}`, text });
    }
  }
  return snapshots;
}
