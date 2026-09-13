import { createServer, createConnection, type Socket } from 'node:net';
import { mkdirSync, lstatSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getDataDir } from '@pacifico/core/paths';
import { DeliveryUnknownError, type SessionAdapter } from './adapters';
import { version } from '../../../../package.json';

function channelPath(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid Claude session ID.');
  const root = `/tmp/pacifico-channels-${process.getuid?.()}`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error('Unsafe channel directory.');
  chmodSync(root, 0o700);
  return `${root}/${createHash('sha256')
    .update(getDataDir() + ':' + id)
    .digest('hex')
    .slice(0, 24)}.sock`;
}

/** Runs inside the receiving Claude session as an explicitly enabled official MCP channel. */
export async function serveClaudeChannel(id: string) {
  const mcp = new Server(
    { name: 'pacifico', version },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        'Pacifico delivers user-authorized tasks into this existing session. After handling a channel message, call reply with its request_id and your final answer. Keep the current session permissions. Do not claim completion before finishing the task.',
    },
  );
  let active: { request: string; socket: Socket } | undefined;
  const reply = z.object({ request_id: z.string().uuid(), text: z.string().max(1_000_000) }).strict();
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Return the final answer for a Pacifico channel request.',
        inputSchema: {
          type: 'object',
          properties: { request_id: { type: 'string' }, text: { type: 'string' } },
          required: ['request_id', 'text'],
          additionalProperties: false,
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'reply') throw new Error('Unknown tool.');
    const args = reply.parse(req.params.arguments);
    if (!active || active.request !== args.request_id) throw new Error('Unknown or completed request.');
    active.socket.end(JSON.stringify({ text: args.text }) + '\n');
    active = undefined;
    return { content: [{ type: 'text', text: 'Reply delivered.' }] };
  });
  const server = createServer((socket) => {
    let data = '',
      handled = false;
    socket.on('error', () => {});
    socket.setTimeout(10000, () => {
      if (!handled) socket.destroy();
    });
    socket.on('data', (chunk) => {
      if (handled) return;
      data += chunk.toString();
      if (data.length > 100000) {
        socket.destroy();
        return;
      }
      if (!data.includes('\n')) return;
      handled = true;
      try {
        const request = z
          .object({ request: z.string().uuid(), message: z.string().trim().min(1).max(64000) })
          .strict()
          .parse(JSON.parse(data.split('\n')[0]!));
        if (active) throw new Error('Channel has an unfinished request. No message was sent.');
        active = { request: request.request, socket };
        void mcp
          .notification({
            method: 'notifications/claude/channel',
            params: { content: request.message, meta: { request_id: request.request } },
          })
          .catch(() => socket.destroy());
      } catch (error) {
        socket.end(JSON.stringify({ error: String(error) }) + '\n');
      }
    });
  });
  await mcp.connect(new StdioServerTransport());
  // Do not unlink an existing endpoint: another receiving session may own it.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(channelPath(id), resolve);
  });
  chmodSync(channelPath(id), 0o600);
  mcp.onclose = () => {
    active?.socket.destroy();
    server.close();
  };
}

/** A socket write is not delivery confirmation; only Claude's correlated reply completes a request. */
export function connectClaude(id: string, onExit: () => void): SessionAdapter {
  let active: Socket | undefined;
  return {
    id,
    send(message) {
      if (active) return Promise.reject(new Error('Channel is busy.'));
      return new Promise((resolve, reject) => {
        const socket = createConnection(channelPath(id));
        active = socket;
        let data = '',
          delivered = false,
          completed = false;
        socket.on('connect', () => {
          delivered = true;
          socket.write(JSON.stringify({ request: randomUUID(), message }) + '\n');
        });
        socket.on('data', (chunk) => {
          data += chunk.toString();
          if (data.length > 2_000_000) {
            socket.destroy();
            return;
          }
          if (!data.includes('\n')) return;
          completed = true;
          try {
            const result = JSON.parse(data.split('\n')[0]!);
            if (result.error) reject(new Error(result.error));
            else resolve(z.string().parse(result.text));
          } catch (error) {
            reject(error);
          }
          socket.end();
        });
        socket.on('error', (error) => {
          if (!delivered)
            reject(
              new Error(
                `Claude channel is not connected. Enable pacifico channel ${id} in that session. ${error.message}`,
              ),
            );
        });
        socket.on('close', () => {
          active = undefined;
          if (!completed && delivered)
            reject(new DeliveryUnknownError('Claude channel disconnected before replying. Delivery is unknown.'));
          if (!completed) onExit();
        });
      });
    },
    close() {
      active?.destroy();
      onExit();
    },
  };
}
