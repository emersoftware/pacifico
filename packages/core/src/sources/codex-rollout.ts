import { existsSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

/** Plain and compressed rollouts share the plain path as their archive identity. */
export function codexRolloutPath(path: string): string {
  const plain = path.endsWith('.jsonl.zst') ? path.slice(0, -4) : path;
  return existsSync(plain) ? plain : plain + '.zst';
}

export function readCodexRollout(path: string): Buffer {
  const source = codexRolloutPath(path);
  const bytes = readFileSync(source);
  return source.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes;
}
