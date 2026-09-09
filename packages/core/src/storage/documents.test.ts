import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNativeDocuments } from '../sources/native-memory';
import { archiveDocuments, readArchivedDocuments } from './documents';

test('native memory copies remain readable after the harness removes the originals', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-documents-'));
  try {
    const source = join(home, '.claude/projects/project/memory');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'MEMORY.md'), '\uFEFF# Existing native memory\n');
    const documents = readNativeDocuments(home);
    const archive = join(home, 'archive');
    archiveDocuments(archive, documents);
    rmSync(source, { recursive: true });
    archiveDocuments(archive, []);
    expect(readArchivedDocuments(archive)).toEqual(documents);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('failed document publication removes its temporary file and preserves the destination', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-document-failure-'));
  try {
    const source = join(home, '.codex/memories');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'MEMORY.md'), 'native content');
    const documents = readNativeDocuments(home);
    const document = documents[0]!;
    const id = createHash('sha256')
      .update(document.harness + '\0' + document.path)
      .digest('hex');
    const archive = join(home, 'archive');
    const destination = join(archive, id + '.json');
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'keep'), 'existing');
    expect(() => archiveDocuments(archive, documents)).toThrow();
    expect(readdirSync(archive)).toEqual([id + '.json']);
    expect(readdirSync(destination)).toEqual(['keep']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('invalid native bytes and replacement symlinks do not overwrite the last memory copy', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-document-invalid-'));
  try {
    const source = join(home, '.codex/memories');
    mkdirSync(source, { recursive: true });
    const path = join(source, 'MEMORY.md');
    writeFileSync(path, 'Original native memory');
    const documents = readNativeDocuments(home);
    const archive = join(home, 'archive');
    archiveDocuments(archive, documents);
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    expect(readNativeDocuments(home)).toEqual([]);
    archiveDocuments(archive, readNativeDocuments(home));
    expect(readArchivedDocuments(archive)).toEqual(documents);
    rmSync(path);
    const external = join(home, 'external.md');
    writeFileSync(external, 'Unrelated content');
    symlinkSync(external, path);
    expect(readNativeDocuments(home)).toEqual([]);
    archiveDocuments(archive, readNativeDocuments(home));
    expect(readArchivedDocuments(archive)).toEqual(documents);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('archive integrity covers source identity as well as content', () => {
  const home = mkdtempSync(join(tmpdir(), 'pacifico-document-identity-'));
  try {
    const source = join(home, '.codex/memories');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'MEMORY.md'), 'native content');
    const documents = readNativeDocuments(home);
    const archive = join(home, 'archive');
    archiveDocuments(archive, documents);
    const path = join(archive, readdirSync(archive)[0]!);
    const original = readFileSync(path, 'utf8');
    for (const override of [{ harness: 'claude' }, { path: '/different/MEMORY.md' }]) {
      writeFileSync(path, JSON.stringify({ ...documents[0], ...override }));
      expect(() => readArchivedDocuments(archive)).toThrow('identity mismatch');
    }
    writeFileSync(path, JSON.stringify({ ...documents[0], content: 'modified' }));
    expect(() => readArchivedDocuments(archive)).toThrow('checksum mismatch');
    writeFileSync(path, original);
    expect(readArchivedDocuments(archive)).toEqual(documents);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
