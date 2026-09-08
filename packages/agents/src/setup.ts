import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, sep, basename } from 'node:path';
import { C } from '@pacifico/core/colors';
import { PLUGIN_FILES } from './plugin-files';
import { removeLegacyHook } from './legacy-hook';
import { getDataDir, getHome } from '@pacifico/core/paths';
import { stopDaemon } from './daemon';
import { installedExecutable } from './executable';
import {
  cleanDeadConfigs,
  codexManualBlock,
  detectClients,
  unwireCodex,
  unwireJsonClient,
  wireCodex,
  wireJsonClient,
  type McpClient,
  type WireResult,
} from './mcp-config';

/** The pacifico data dir. Single source of truth is getDataDir() - the memory store
 *  lives in the same directory, and the two must never disagree about where it is. */
function sessionsDir(): string {
  return getDataDir();
}
function pluginDest(): string {
  return join(sessionsDir(), 'plugin');
}
/**
 * The only paths the installer creates inside the data dir. Uninstall removes
 * exactly these - NOT the directory itself.
 *
 * The data dir also holds memory.db, whose approve/reject/snooze rows are human
 * judgments no re-mine can reconstruct. `pacifico cleanup` routes through
 * runUninstall() (index.ts:28-34), so an `rm -rf` of the whole directory would
 * silently destroy every triage decision the user ever made - the same disposability
 * assumption that is correct for index.db and wrong here.
 */
function ownedInstallPaths(): string[] {
  return [pluginDest(), join(sessionsDir(), '.claude-plugin')];
}
const PLUGIN_VERSION = '0.2.0';
const MARKETPLACE_NAME = 'pacifico';
const PLUGIN_NAME = 'pacifico';

function installPluginFromEmbed(): boolean {
  try {
    mkdirSync(dirname(pluginDest()), { recursive: true });
    for (const [relPath, content] of Object.entries(PLUGIN_FILES)) {
      const dest = join(pluginDest(), relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return true;
  } catch {
    return false;
  }
}

function writeMarketplaceJson(): void {
  const marketplace = {
    name: MARKETPLACE_NAME,
    owner: { name: 'emersoftware' },
    metadata: { description: 'Local session search and reading through MCP', version: PLUGIN_VERSION },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: './plugin',
        description: 'Search and read archived coding conversations through MCP.',
      },
    ],
  };
  const dir = join(sessionsDir(), '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
}

function installPlugin(): boolean {
  const ok = installPluginFromEmbed();
  if (ok) writeMarketplaceJson();
  return ok;
}

/** Older releases linked their skills into Pi; upgrades remove only those links. */
function piSkillsDir(): string {
  return join(getHome(), '.pi', 'agent', 'skills');
}

/** Remove only links that point into our plugin skills dir; anything else stays. */
export function unlinkPiSkills(skillsDir = piSkillsDir(), pluginSkills = join(pluginDest(), 'skills')): string[] {
  if (!existsSync(skillsDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const dest = join(skillsDir, name);
    try {
      if (!lstatSync(dest).isSymbolicLink()) continue;
      const target = readlinkSync(dest);
      if (target !== join(pluginSkills, name) && !target.startsWith(pluginSkills + sep)) continue;
      rmSync(dest);
      removed.push(name);
    } catch {}
  }
  return removed;
}

function sessionsCommand(): string {
  // A compiled install must keep working when the invoking shell's PATH is not
  // inherited by an editor. Use the installed executable, with a stable Homebrew alias when available.
  if (basename(process.execPath) !== 'bun') return installedExecutable(process.execPath);
  try {
    const result = Bun.spawnSync(['which', 'pacifico']);
    const path = new TextDecoder().decode(result.stdout).trim();
    if (path) return path;
  } catch {}
  return 'pacifico';
}

/**
 * Write the MCP entry into the file this client actually reads.
 *
 * Claude Code has no config of its own here: its server arrives with the plugin, which
 * is also the reason the old dotfile bug went unnoticed for so long - the one client
 * most likely to be tested worked through a path setup never touched.
 */
function wire(client: McpClient): WireResult {
  if (!client.configPath) return { status: 'unchanged' };
  const cmd = sessionsCommand();
  return client.id === 'codex' ? wireCodex(client.configPath, cmd) : wireJsonClient(client.configPath, client.id, cmd);
}

function unwire(client: McpClient): WireResult {
  if (!client.configPath) return { status: 'unchanged' };
  return client.id === 'codex' ? unwireCodex(client.configPath) : unwireJsonClient(client.configPath);
}

function runClaude(...args: string[]): boolean {
  try {
    const result = Bun.spawnSync(['claude', 'plugins', ...args], { stderr: 'pipe', stdout: 'pipe' });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

interface PluginRegistration {
  marketplace: boolean;
  install: boolean;
}

function registerClaudePlugin(): PluginRegistration {
  const marketplace = runClaude('marketplace', 'add', sessionsDir());
  const install = runClaude('install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  return { marketplace, install };
}

function unregisterClaudePlugin(): void {
  runClaude('uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  runClaude('marketplace', 'remove', MARKETPLACE_NAME);
}

export function runSetup(): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}pacifico setup${C.reset}\n\n`);

  removeLegacyHook();
  unlinkPiSkills();
  // This subtree contains only installer-owned skills from retired releases.
  rmSync(join(pluginDest(), 'skills'), { recursive: true, force: true });

  if (installPlugin()) {
    w(`  ${C.green}✓${C.reset} Plugin installed to ${C.dim}${pluginDest()}${C.reset}\n`);
  } else {
    w(`  ${C.red}✗${C.reset} Failed to install plugin to ${pluginDest()}\n`);
    process.exit(1);
  }

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config ${C.dim}${path}${C.reset}\n`);
  }

  const detected = detectClients().filter((t) => t.detected);

  if (detected.length === 0) {
    w(`\n  ${C.dim}No AI tools detected. Install Claude Code, Cursor, Codex, or Pi first.${C.reset}\n\n`);
    process.exit(0);
  }

  for (const tool of detected) {
    // Report what the write actually did. The previous version printed a checkmark for
    // every client whose file it managed to create, including three no client reads.
    const res = wire(tool);
    if (res.status === 'added') {
      w(
        `  ${C.green}✓${C.reset} MCP server added to ${C.dim}${tool.name}${C.reset} ${C.dim}(${tool.configPath})${C.reset}\n`,
      );
    } else if (res.status === 'unchanged' && tool.configPath) {
      w(`  ${C.dim}ℹ${C.reset} MCP server already configured for ${C.dim}${tool.name}${C.reset}\n`);
    } else if (res.status === 'refused') {
      w(`  ${C.yellow}!${C.reset} Left ${C.dim}${tool.configPath}${C.reset} alone - ${res.reason}\n`);
      if (tool.id === 'codex') {
        w(`  ${C.dim}  Add this yourself:${C.reset}\n`);
        for (const line of codexManualBlock(sessionsCommand()).split('\n')) w(`  ${C.dim}    ${line}${C.reset}\n`);
      }
    } else if (res.status === 'failed') {
      w(`  ${C.red}✗${C.reset} Failed to configure MCP for ${tool.name} - ${res.reason}\n`);
    }

    if (tool.id === 'claude') {
      const result = registerClaudePlugin();
      if (result.marketplace) {
        w(`  ${C.green}✓${C.reset} Marketplace added to ${C.dim}${tool.name}${C.reset}\n`);
      } else {
        w(`  ${C.dim}ℹ${C.reset} Marketplace already registered with ${C.dim}${tool.name}${C.reset}\n`);
      }
      if (result.install) {
        w(`  ${C.green}✓${C.reset} Plugin installed in ${C.dim}${tool.name}${C.reset}\n`);
      } else {
        w(`  ${C.dim}ℹ${C.reset} Plugin already installed in ${C.dim}${tool.name}${C.reset}\n`);
      }
    }
  }
}

export function runUninstall(): void {
  stopDaemon();
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}pacifico uninstall${C.reset}\n\n`);

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config ${C.dim}${path}${C.reset}\n`);
  }

  for (const tool of detectClients().filter((t) => t.detected)) {
    const res = unwire(tool);
    if (res.status === 'added') {
      w(`  ${C.green}✓${C.reset} Removed MCP config from ${C.dim}${tool.name}${C.reset}\n`);
    } else if (res.status === 'refused' || res.status === 'failed') {
      w(`  ${C.yellow}!${C.reset} Left ${C.dim}${tool.configPath}${C.reset} alone - ${res.reason}\n`);
    }

    if (tool.id === 'claude') {
      unregisterClaudePlugin();
      w(`  ${C.green}✓${C.reset} Removed plugin from ${C.dim}${tool.name}${C.reset}\n`);

      if (removeLegacyHook()) {
        w(`  ${C.green}✓${C.reset} Removed SessionStart auto-injection from ${C.dim}${tool.name}${C.reset}\n`);
      }
    }

    if (tool.id === 'pi') {
      const removed = unlinkPiSkills();
      if (removed.length) {
        w(
          `  ${C.green}✓${C.reset} Removed ${removed.length} skill link${removed.length === 1 ? '' : 's'} from ${C.dim}Pi${C.reset}\n`,
        );
      }
    }
  }

  for (const path of removeInstalledFiles()) {
    w(`  ${C.green}✓${C.reset} Removed ${C.dim}${path}${C.reset}\n`);
  }

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}

/**
 * Delete the installer-owned subtrees of the data dir and return what was removed.
 *
 * Exported as the seam durability tests exercise: the rest of runUninstall talks to
 * the real ~/.claude config and shells out to `claude plugins uninstall`, so no test
 * may call it - but this is the only part that touches the data dir, and it must be
 * provably scoped to the two directories the installer created.
 */
export function removeInstalledFiles(): string[] {
  const removed: string[] = [];
  for (const path of ownedInstallPaths()) {
    if (!existsSync(path)) continue;
    try {
      require('node:fs').rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {}
  }
  return removed;
}
