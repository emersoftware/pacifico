import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importDocuments } from './documents';

test('native memory search rebuilds from its archive after native deletion', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-memory-import-'));
  let db = new Database(':memory:');
  try {
    const native = join(home, '.codex/memories');
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'MEMORY.md'), 'quartz native memory');
    const archive = join(home, 'archive');
    expect(importDocuments(db, home, archive)).toBe(1);
    rmSync(native, { recursive: true });
    db.close();
    db = new Database(':memory:');
    expect(importDocuments(db, home, archive)).toBe(1);
    expect(
      db.query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'quartz'").get(),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('asynchronous Antigravity output is archived as an artifact and survives deletion', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-task-output-'));
  let db = new Database(':memory:');
  try {
    const native = join(home, '.gemini/antigravity-cli/brain/session/.system_generated/tasks');
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'task-12.log'), 'asyncquartz first output\n');
    const archive = join(home, 'archive');
    expect(importDocuments(db, home, archive)).toBe(1);
    writeFileSync(join(native, 'task-12.log'), 'asyncquartz first output\nfinishedquartz\n');
    expect(importDocuments(db, home, archive)).toBe(1);
    rmSync(native, { recursive: true });
    db.close();
    db = new Database(':memory:');
    expect(importDocuments(db, home, archive)).toBe(1);
    expect(
      db
        .query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'finishedquartz'")
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('indexed project instructions remain searchable after their project disappears', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-project-import-'));
  let db = new Database(':memory:');
  try {
    const project = join(home, 'project');
    mkdirSync(join(project, '.cursor/rules'), { recursive: true });
    writeFileSync(join(project, '.cursor/rules/style.mdc'), 'projectquartz instructions');
    db.exec('CREATE TABLE sessions (tool TEXT, cwd TEXT)');
    db.query('INSERT INTO sessions VALUES (?, ?)').run('cursor', project);
    const archive = join(home, 'archive');
    expect(importDocuments(db, home, archive)).toBe(1);
    rmSync(project, { recursive: true });
    db.close();
    db = new Database(':memory:');
    expect(importDocuments(db, home, archive)).toBe(1);
    expect(
      db
        .query("SELECT count(*) AS count FROM native_document_fts WHERE native_document_fts MATCH 'projectquartz'")
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('memory imports follow session roots unless a native home is explicitly selected', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-memory-precedence-'));
  const keys = ['SESSIONS_NATIVE_HOME', 'SESSIONS_CLAUDE_DIR', 'SESSIONS_CODEX_DIR'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const db = new Database(':memory:');
  try {
    const relocated = join(home, 'relocated');
    for (const [directory, content] of [
      [join(home, '.codex/memories'), 'homequartz'],
      [join(relocated, 'codex/memories'), 'redirectquartz'],
      [join(relocated, 'claude/project/memory'), 'claudequartz'],
    ]) {
      mkdirSync(directory!, { recursive: true });
      writeFileSync(join(directory!, 'MEMORY.md'), content!);
    }
    delete process.env.SESSIONS_NATIVE_HOME;
    process.env.SESSIONS_CODEX_DIR = join(relocated, 'codex/sessions');
    process.env.SESSIONS_CLAUDE_DIR = join(relocated, 'claude');
    expect(importDocuments(db, home, join(home, 'archive-relocated'))).toBe(2);
    expect(db.query('SELECT content FROM native_documents ORDER BY content').all()).toEqual([
      { content: 'claudequartz' },
      { content: 'redirectquartz' },
    ]);
    const isolatedDb = new Database(':memory:');
    try {
      process.env.SESSIONS_NATIVE_HOME = home;
      expect(importDocuments(isolatedDb, home, join(home, 'archive-home'))).toBe(1);
      expect(isolatedDb.query('SELECT content FROM native_documents').all()).toEqual([{ content: 'homequartz' }]);
    } finally {
      isolatedDb.close();
    }
  } finally {
    db.close();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
