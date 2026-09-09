import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../paths';
import { z } from 'zod';
import { identitySchema, type Identity } from './protocol';

const configSchema = z.object({
  endpoint: z.string().url(),
  token: z.string().min(32),
  identity: identitySchema,
  allowHttp: z.boolean().default(false),
});
export type RemoteConfig = z.infer<typeof configSchema>;
const configPath = () => join(getDataDir(), 'remote.json');
export function remoteConfig(): RemoteConfig | null {
  if (!existsSync(configPath())) return null;
  return configSchema.parse(JSON.parse(readFileSync(configPath(), 'utf8')));
}
export function validateEndpoint(endpoint: string, allowHttp = false): string {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Endpoint must not contain credentials, a query or a fragment');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use HTTPS, or --allow-http for a trusted private network');
  return url.toString().replace(/\/$/, '');
}
/** Credentials stay bound to the configured origin; redirects never forward them. */
export async function remoteRequest(
  config: Pick<RemoteConfig, 'endpoint' | 'token' | 'allowHttp'>,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const endpoint = validateEndpoint(config.endpoint, config.allowHttp);
  const response = await fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Pacifico server returned HTTP ${response.status}`);
  return response.json();
}
export async function connectRemote(endpoint: string, token: string, allowHttp = false): Promise<Identity> {
  const config = { endpoint: validateEndpoint(endpoint, allowHttp), token: token.trim(), allowHttp };
  const identity = identitySchema.parse(await remoteRequest(config, '/v1/me'));
  configSchema.parse({ ...config, identity });
  mkdirSync(getDataDir(), { recursive: true });
  const temporary = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...config, identity }) + '\n', { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, configPath());
  return identity;
}
export function disconnectRemote(): void {
  rmSync(configPath(), { force: true });
}
