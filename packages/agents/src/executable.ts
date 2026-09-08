import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Keep client configs and launchd jobs valid after Homebrew removes an old keg. */
export function installedExecutable(executable: string): string {
  const keg = /^(.*)\/Cellar\/pacifico\/[^/]+\/bin\/pacifico$/.exec(executable);
  if (!keg) return executable;
  const stable = join(keg[1]!, 'opt', 'pacifico', 'bin', 'pacifico');
  try {
    // Only select an alias that currently resolves to the executable doing setup.
    // Another version or an unrelated symlink must not take over this install.
    if (realpathSync(stable) === realpathSync(executable)) return stable;
  } catch {}
  return executable;
}
