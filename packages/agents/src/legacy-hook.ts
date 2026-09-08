import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHome } from '@pacifico/core/paths';
import { asJsonObject, type JsonValue } from '@pacifico/core/extract-util';

/** Remove the retired Pacifico hook without changing any neighboring hooks. */
export function removeLegacyHook(
  path = join(process.env.SESSIONS_CLAUDE_CONFIG_DIR || join(getHome(), '.claude'), 'settings.json'),
): boolean {
  if (!existsSync(path)) return false;
  try {
    const settings = asJsonObject(JSON.parse(readFileSync(path, 'utf8')));
    const hooks = asJsonObject(settings?.hooks);
    if (!settings || !hooks || !Array.isArray(hooks.SessionStart)) return false;
    let changed = false;
    const groups: JsonValue[] = [];
    for (const entry of hooks.SessionStart) {
      const group = asJsonObject(entry);
      if (!group || !Array.isArray(group.hooks)) {
        groups.push(entry);
        continue;
      }
      const kept = group.hooks.filter((entry) => {
        const hook = asJsonObject(entry);
        return !(hook?.type === 'command' && hook.command === 'pacifico context --hook');
      });
      if (kept.length === group.hooks.length) groups.push(entry);
      else {
        changed = true;
        if (kept.length) groups.push({ ...group, hooks: kept });
      }
    }
    if (!changed) return false;
    if (groups.length) hooks.SessionStart = groups;
    else delete hooks.SessionStart;
    settings.hooks = hooks;
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch (error) {
    process.stderr.write(
      `Could not remove retired Pacifico hook from ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}
