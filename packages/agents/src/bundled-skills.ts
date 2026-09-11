import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getDataDir, getHome } from '@pacifico/core/paths';
import { locations, type HarnessId } from './config-sync/formats';

/** Claude receives this skill from its plugin; other clients discover the linked folder. */
export function bundledSkills(remove = false): string[] {
  const home = getHome();
  const roots: [HarnessId, string][] = [
    ['codex', join(home, '.codex')],
    ['cursor', join(home, '.cursor')],
    ['antigravity', join(home, '.gemini')],
    ['opencode', join(home, '.config/opencode')],
  ];
  const changed: string[] = [];
  for (const [harness, detected] of roots) {
    const legacy = join(locations(harness).skills[0]!, 'decision-finder');
    try {
      if (
        lstatSync(legacy).isSymbolicLink() &&
        resolve(dirname(legacy), readlinkSync(legacy)) === resolve(getDataDir(), 'plugin', 'skills', 'decision-finder')
      ) {
        unlinkSync(legacy);
        changed.push(legacy);
      }
    } catch {
      // No owned legacy link to remove.
    }
    if (!remove && !existsSync(detected)) continue;
    for (const name of ['adr', 'sync']) {
      const source = join(getDataDir(), 'plugin', 'skills', name);
      const target = join(locations(harness).skills[0]!, name);
      let present = false,
        owned = false;
      try {
        present = true;
        owned =
          lstatSync(target).isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === resolve(source);
      } catch {
        present = false;
      }
      if (remove) {
        if (owned) {
          unlinkSync(target);
          changed.push(target);
        }
      } else if (!present && existsSync(join(source, 'SKILL.md'))) {
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(source, target, 'dir');
        changed.push(target);
      }
    }
  }
  return changed;
}
