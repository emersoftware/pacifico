import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '@pacifico/agents/mcp';
import { response, failure } from '@pacifico/agents/remote';
import { snapshotSchema } from '@pacifico/core/sync/protocol';
import { z } from 'zod';
import { Store, Conflict } from './store';
import { queryTools } from './query';

/** Authentication selects the account before any archive query or MCP session exists. */
export function handler(store: Store, publicUrl?: string) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') {
      await store.sql`SELECT 1`;
      return Response.json({ ok: true });
    }
    const origin = request.headers.get('origin');
    if (origin && (!publicUrl || origin !== new URL(publicUrl).origin))
      return new Response('Origin not allowed', { status: 403 });
    const authorization = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    const identity = authorization ? await store.authenticate(authorization[1]!) : null;
    if (!identity) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    try {
      if (path === '/v1/me' && request.method === 'GET') return Response.json(identity);
      if (path === '/v1/inventory' && request.method === 'GET') {
        if (identity.scope !== 'sync') return new Response('Read-only credential', { status: 403 });
        return Response.json(await store.inventory(identity));
      }
      if (path === '/v1/snapshots' && request.method === 'POST') {
        if (identity.scope !== 'sync') return new Response('Read-only credential', { status: 403 });
        const body = z
          .object({
            snapshot: snapshotSchema,
            previousHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict()
          .parse(await request.json());
        return Response.json((await store.save(identity, body.snapshot, body.previousHash)) ?? { unchanged: true });
      }
      if (path === '/mcp') {
        if (request.method !== 'POST')
          return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
        const exclude = request.headers.get('x-pacifico-exclude-device') ?? undefined;
        if (exclude && !z.uuid().safeParse(exclude).success) return new Response('Invalid device', { status: 400 });
        const query = queryTools(store, identity, exclude);
        const mcp = createServer({
          resources: false,
          execute: async (name, args) => {
            try {
              return response(await query(name, args));
            } catch (error) {
              return failure(error instanceof Error ? error.message : 'Query failed');
            }
          },
        });
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        await mcp.connect(transport);
        try {
          return await transport.handleRequest(request);
        } finally {
          await mcp.close();
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof Conflict) return new Response(error.message, { status: 409 });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return new Response('Invalid request', { status: 400 });
      console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error');
      return new Response('Server error', { status: 500 });
    }
  };
}
