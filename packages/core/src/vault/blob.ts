import { archiveSummary } from './compact';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

/** One decoder for legacy plain JSONL and portable compressed archive objects. */
export function readArchive(path: string): string {
  const bytes = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8');
}

/** Immutable, content-addressed objects allow source aliases to share storage. */
export function storeArchive(dir: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  const folder = join(dir, 'objects');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, hash + '.jsonl.gz');
  const summary = archiveSummary(content.trimEnd().split('\n'));
  const summaryPath = path + '.summary.json';
  if (existsSync(path)) {
    if (readArchive(path) !== content) throw new Error('Archive object failed content verification');
    if (summary && !existsSync(summaryPath)) writeFileSync(summaryPath, JSON.stringify(summary));
    return path;
  }
  const temp = path + `.tmp-${process.pid}`;
  try {
    writeFileSync(temp, gzipSync(content));
    if (readArchiveGzip(temp) !== content) throw new Error('Archive compression failed round-trip verification');
    const fd = openSync(temp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    if (summary) {
      writeFileSync(summaryPath + '.tmp', JSON.stringify(summary));
      renameSync(summaryPath + '.tmp', summaryPath);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}
function readArchiveGzip(path: string): string {
  return gunzipSync(readFileSync(path)).toString('utf8');
}
