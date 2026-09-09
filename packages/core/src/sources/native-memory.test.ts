import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readNativeDocuments } from './native-memory';

test('native documents retain provenance and distinguish instructions from memory', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-native-memory-'));
  try {
    const files = {
      '.claude/projects/project/memory/MEMORY.md': '\uFEFF# User preferences\n',
      '.codex/memories/rollout_summaries/session.md': '# Existing summary\n',
      '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nUse tabs.\n',
      '.gemini/antigravity/knowledge/topic/overview.md': '# Existing knowledge\n',
      '.gemini/antigravity/brain/session/task.md': '- [ ] Work item\n',
      '.gemini/antigravity-cli/brain/session/.system_generated/tasks/task-12.log': 'async command output\n',
      '.gemini/antigravity/knowledge/knowledge.lock': '',
      '.config/opencode/AGENTS.md': 'Run tests.\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const path = join(home, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    const docs = readNativeDocuments(home);
    expect(docs).toHaveLength(7);
    expect(docs.filter((d) => d.kind === 'memory')).toHaveLength(3);
    expect(docs.filter((d) => d.kind === 'instructions')).toHaveLength(2);
    expect(docs.filter((d) => d.kind === 'artifact')).toHaveLength(2);
    for (const doc of docs) {
      expect(doc.content).toBe(readFileSync(doc.path, 'utf8'));
      expect(doc.sha256).toHaveLength(64);
    }
    expect(readNativeDocuments(home)).toEqual(docs);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('project instructions retain harness provenance and skip unrelated directories', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-project-docs-'));
  try {
    const project = join(home, 'project');
    mkdirSync(join(project, '.cursor/rules'), { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'shared instructions');
    writeFileSync(join(project, '.cursor/rules/style.mdc'), 'cursor instructions');
    writeFileSync(join(project, 'unrelated.md'), 'not a harness document');
    const docs = readNativeDocuments(home, [
      { harness: 'codex', cwd: project },
      { harness: 'opencode', cwd: project },
      { harness: 'cursor', cwd: project },
      { harness: 'cursor', cwd: project },
      { harness: 'claude', cwd: join(home, 'missing') },
    ]);
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.kind === 'instructions')).toBe(true);
    expect(docs.map((d) => d.harness).sort()).toEqual(['codex', 'cursor', 'opencode']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('explicit memory roots follow relocated Claude and Codex stores', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-memory-roots-'));
  try {
    const claudeProjects = join(home, 'relocated/claude-projects');
    const codexHome = join(home, 'relocated/codex-home');
    const paths = [join(claudeProjects, 'project/memory/MEMORY.md'), join(codexHome, 'memories/MEMORY.md')];
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'native relocated memory');
    }
    expect(readNativeDocuments(home)).toEqual([]);
    const documents = readNativeDocuments(home, [], { claudeProjects, codexHome });
    expect(documents.map((document) => document.path).sort()).toEqual(paths.sort());
    expect(documents.map((document) => document.harness).sort()).toEqual(['claude', 'codex']);
    expect(documents.every((document) => document.kind === 'memory')).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
