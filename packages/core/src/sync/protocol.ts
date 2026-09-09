import { createHash } from 'node:crypto';
import { z } from 'zod';

export const harness = z.enum(['claude', 'codex', 'cursor', 'antigravity', 'opencode']);
export const snapshotSchema = z
  .object({
    kind: z.enum(['session', 'memory', 'instructions', 'artifact']),
    harness,
    sourcePath: z.string().min(1).max(16000),
    sessionId: z.string().max(4000).default(''),
    cwd: z.string().max(16000).default(''),
    modifiedAt: z.iso.datetime(),
    content: z.string(),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const identitySchema = z.object({
  userId: z.string(),
  user: z.string(),
  deviceId: z.string().nullable(),
  device: z.string().nullable(),
  scope: z.enum(['sync', 'read']),
});
export type Identity = z.infer<typeof identitySchema>;
export const inventorySchema = z.array(z.object({ key: z.string(), hash: z.string() }));
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function snapshotKey(item: Pick<Snapshot, 'kind' | 'harness' | 'sourcePath'>): string {
  return hash(JSON.stringify([item.kind, item.harness, item.sourcePath]));
}
export function snapshotHash(item: Snapshot): string {
  return hash(JSON.stringify(item));
}
export const remoteId = (device: string, key: string) => `pacifico://${device}/${key}`;
export function parseRemoteId(id: string): { device: string; key: string } {
  const match = id.match(/^pacifico:\/\/([a-f0-9-]{36})\/([a-f0-9]{64})$/);
  if (!match) throw new Error('Invalid remote record ID');
  return { device: match[1]!, key: match[2]! };
}
export type ToolName = 'search_sessions' | 'read_session' | 'get_context' | 'native_documents';
