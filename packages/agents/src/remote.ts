import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { remoteConfig, validateEndpoint, type RemoteConfig } from '@pacifico/core/sync/client';
import { type ToolName } from '@pacifico/core/sync/protocol';

export type ToolResponse = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export type ToolExecutor = (name: ToolName, args: Record<string, unknown>) => Promise<ToolResponse>;
export const response = (data: Record<string, unknown>): ToolResponse => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
export const failure = (message: string): ToolResponse => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/** Each remote request is authenticated; closing a client leaves no persistent server session. */
export async function callRemoteTool(
  config: RemoteConfig,
  name: ToolName,
  args: Record<string, unknown>,
  excludeDevice = false,
): Promise<ToolResponse> {
  const client = new Client({ name: 'pacifico', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(validateEndpoint(config.endpoint, config.allowHttp) + '/mcp'),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(excludeDevice && config.identity.deviceId
            ? { 'X-Pacifico-Exclude-Device': config.identity.deviceId }
            : {}),
        },
        redirect: 'error',
      },
    },
  );
  try {
    await client.connect(transport, { timeout: 5000 });
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: { ...args, scope: 'remote' } }, undefined, { timeout: 15000 }),
    );
    if (result.isError)
      return failure(
        result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      );
    if (!result.structuredContent) throw new Error('Remote server returned no structured result');
    return response(result.structuredContent);
  } finally {
    await client.close();
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const array = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(object) : []);
const n = (value: unknown) => (typeof value === 'number' ? value : 0);
function interleave(a: Record<string, unknown>[], b: Record<string, unknown>[], limit: number) {
  const combined: Record<string, unknown>[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && combined.length < limit; i++) {
    if (a[i]) combined.push(a[i]!);
    if (b[i]) combined.push(b[i]!);
  }
  return combined.slice(0, limit);
}

/** Federation never makes an unavailable server hide usable local results. */
export async function routeTool(
  name: ToolName,
  args: Record<string, unknown>,
  local: () => Promise<ToolResponse>,
  executor?: ToolExecutor,
): Promise<ToolResponse> {
  if (name === 'get_context' && args.mode === 'decisions') {
    if (executor || args.scope === 'remote' || args.scope === 'all' || args.device)
      return failure('Saved decisions are local. Use scope local without a device filter.');
    return local();
  }
  if (executor) return executor(name, args);
  const remoteRead =
    (name === 'read_session' && String(args.filePath).startsWith('pacifico://')) ||
    (name === 'native_documents' && args.mode === 'read' && String(args.id).startsWith('pacifico://'));
  let config: RemoteConfig | null;
  try {
    config = remoteConfig();
  } catch {
    if (remoteRead || args.scope === 'remote' || args.device)
      return failure('Remote configuration is invalid. Run pacifico remote connect again.');
    const own = await local();
    if (
      own.isError ||
      args.scope === 'local' ||
      name === 'read_session' ||
      (name === 'native_documents' && args.mode === 'read')
    )
      return own;
    return response({
      ...own.structuredContent,
      remote: { available: false, error: 'Remote configuration is invalid; results contain local data only.' },
    });
  }
  const differentDevice = !!args.device && args.device !== config?.identity.deviceId;
  if (differentDevice && args.scope === 'local') return failure('The requested device is not local. Use remote scope.');
  const scope = differentDevice ? 'remote' : (args.scope ?? (config ? 'all' : 'local'));
  if (remoteRead || scope === 'remote') {
    if (!config) return failure('No remote server configured. Run pacifico remote connect.');
    try {
      return await callRemoteTool(config, name, args);
    } catch (error) {
      return failure(`Remote unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const own = await local();
  if (
    scope === 'local' ||
    !config ||
    own.isError ||
    name === 'read_session' ||
    (name === 'native_documents' && args.mode === 'read')
  )
    return own;
  const effective = { ...args };
  if (name === 'get_context' && (!args.mode || args.mode === 'project')) effective.cwd = args.cwd ?? process.cwd();
  try {
    const other = await callRemoteTool(config, name, effective, true);
    if (other.isError) throw new Error(other.content[0]?.text ?? 'Remote query failed');
    const merged = structuredClone(own.structuredContent ?? {}),
      remote = other.structuredContent ?? {};
    const localData = object(object(merged.result).data),
      remoteData = object(object(remote.result).data);
    if (name === 'native_documents')
      merged.results = interleave(array(merged.results), array(remote.results), n(args.limit) || 20);
    if (name === 'search_sessions') {
      const mode = args.mode ?? 'ranked',
        limit = n(args.limit) || (mode === 'ranked' ? 20 : 50);
      const field = mode === 'ranked' ? 'results' : 'hits',
        a = array(localData[field]),
        b = array(remoteData[field]);
      localData[field] = interleave(a, b, limit);
      if (mode === 'ranked') localData.count = (localData[field] as unknown[]).length;
      else {
        localData.totalHits = n(localData.totalHits) + n(remoteData.totalHits);
        localData.totalSessions = n(localData.totalSessions) + n(remoteData.totalSessions);
        localData.returnedHits = (localData[field] as unknown[]).length;
        localData.truncated =
          !!localData.truncated || !!remoteData.truncated || n(localData.totalHits) > n(localData.returnedHits);
      }
    }
    if (name === 'get_context') {
      if (args.mode === 'activity') {
        localData.totalSessions = n(localData.totalSessions) + n(remoteData.totalSessions);
        localData.totalMessages = n(localData.totalMessages) + n(remoteData.totalMessages);
        const tools = object(localData.tools);
        for (const [key, value] of Object.entries(object(remoteData.tools))) tools[key] = n(tools[key]) + n(value);
        localData.tools = tools;
        localData.projects = [
          ...new Set([...((localData.projects as string[]) ?? []), ...((remoteData.projects as string[]) ?? [])]),
        ];
        // Per-device project groups retain their own counts and remote file identifiers.
        const days = new Map<string, Record<string, unknown>>();
        for (const day of [...array(localData.days), ...array(remoteData.days)]) {
          const key = String(day.date),
            prior = days.get(key);
          days.set(
            key,
            prior
              ? {
                  ...prior,
                  sessions: n(prior.sessions) + n(day.sessions),
                  projects: [...array(prior.projects), ...array(day.projects)],
                }
              : day,
          );
        }
        localData.days = [...days.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
        localData.truncated = !!localData.truncated || !!remoteData.truncated;
      } else {
        localData.recent = [...array(localData.recent), ...array(remoteData.recent)]
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, n(args.limit) || 10);
        localData.headlines = [...array(localData.headlines), ...array(remoteData.headlines)];
        localData.isEmpty =
          (localData.recent as unknown[]).length === 0 && (localData.headlines as unknown[]).length === 0;
      }
    }
    return response({ ...merged, remote: { available: true } });
  } catch {
    return response({
      ...own.structuredContent,
      remote: { available: false, error: 'Remote server unavailable; results contain local data only.' },
    });
  }
}
