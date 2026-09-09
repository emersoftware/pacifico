import { Glob } from 'bun';
import { lstatSync, readFileSync, type BigIntStats } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

import { type Harness } from './records';
export type NativeDocumentKind = 'memory' | 'instructions' | 'artifact';

export interface NativeDocument {
  harness: Harness;
  kind: NativeDocumentKind;
  path: string;
  content: string;
  sha256: string;
  modifiedAt: string;
}

interface Location {
  harness: Harness;
  kind: NativeDocumentKind;
  pattern: string;
}

// Rules and session artifacts remain distinct from persistent native memory.
const locations: Location[] = [
  { harness: 'claude', kind: 'memory', pattern: '.claude/projects/*/memory/**/*.md' },
  { harness: 'claude', kind: 'instructions', pattern: '.claude/CLAUDE.md' },
  { harness: 'claude', kind: 'instructions', pattern: '.claude/rules/**/*.md' },
  { harness: 'codex', kind: 'memory', pattern: '.codex/memories/**/*.md' },
  { harness: 'codex', kind: 'instructions', pattern: '.codex/AGENTS.md' },
  { harness: 'codex', kind: 'instructions', pattern: '.codex/AGENTS.override.md' },
  { harness: 'cursor', kind: 'instructions', pattern: '.cursor/rules/**/*.mdc' },
  { harness: 'antigravity', kind: 'memory', pattern: '.gemini/antigravity*/knowledge/**/*.md' },
  { harness: 'antigravity', kind: 'artifact', pattern: '.gemini/antigravity*/brain/*/*.md' },
  {
    harness: 'antigravity',
    kind: 'artifact',
    pattern: '.gemini/antigravity*/brain/*/.system_generated/tasks/task-*.log',
  },
  { harness: 'antigravity', kind: 'instructions', pattern: '.gemini/GEMINI.md' },
  { harness: 'opencode', kind: 'instructions', pattern: '.config/opencode/AGENTS.md' },
];

function sameFileVersion(a: BigIntStats, b: BigIntStats): boolean {
  return (
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// Reject observed concurrent writes before replacing a durable document copy.
function readStableDocument(path: string): { bytes: Buffer; modifiedAt: string } | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile()) return;
    const first = readFileSync(path);
    const middle = lstatSync(path, { bigint: true });
    const second = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (sameFileVersion(before, middle) && sameFileVersion(middle, after) && first.equals(second)) {
      return { bytes: second, modifiedAt: new Date(Number(after.mtimeMs)).toISOString() };
    }
  }
}

/** Reads existing harness documents. It neither creates memories nor edits native files. */
export function readNativeDocuments(
  home: string,
  projects: { harness: Harness; cwd: string }[] = [],
  roots: { claudeProjects?: string; codexHome?: string } = {},
): NativeDocument[] {
  const documents: NativeDocument[] = [];
  const seen = new Set<string>();
  const projectPatterns: Record<Harness, string[]> = {
    claude: ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/rules/**/*.md'],
    codex: ['AGENTS.md', 'AGENTS.override.md'],
    cursor: ['.cursor/rules/**/*.mdc', '.cursorrules'],
    antigravity: ['GEMINI.md'],
    opencode: ['AGENTS.md'],
  };
  const scans = locations.map((location) => {
    if (location.harness === 'claude' && location.kind === 'memory' && roots.claudeProjects)
      return { ...location, root: roots.claudeProjects, pattern: '*/memory/**/*.md' };
    if (location.harness === 'codex' && location.kind === 'memory' && roots.codexHome)
      return { ...location, root: roots.codexHome, pattern: 'memories/**/*.md' };
    return { ...location, root: home };
  });
  for (const project of projects) {
    if (!isAbsolute(project.cwd)) continue;
    for (const pattern of projectPatterns[project.harness]) {
      scans.push({ harness: project.harness, kind: 'instructions', pattern, root: project.cwd });
    }
  }
  for (const location of scans) {
    let paths: string[];
    try {
      paths = [...new Glob(location.pattern).scanSync({ cwd: location.root, dot: true, followSymlinks: false })];
    } catch {
      continue;
    }
    for (const relative of paths) {
      const path = join(location.root, relative);
      const identity = location.harness + '\0' + path;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        const snapshot = readStableDocument(path);
        if (!snapshot) continue;
        const { bytes, modifiedAt } = snapshot;
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        documents.push({
          harness: location.harness,
          kind: location.kind,
          path,
          content,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          modifiedAt,
        });
      } catch {
        // A file can disappear while the harness reorganizes its memory directory.
      }
    }
  }
  return documents.sort((a, b) => a.path.localeCompare(b.path));
}
