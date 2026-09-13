import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callControl, ensureControl, type ControlRequest } from './connection';

/** Registered only by an explicitly enabled local execution client. */
export function registerSessionTools(server: McpServer, program: string[]) {
  const invoke = async (request: ControlRequest) => {
    try {
      await ensureControl(program);
      const value = await callControl(request);
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
  server.registerTool(
    'start_session',
    {
      description:
        'Create a new local Claude Code or Codex session for a specific task. Returns a request ID; use read_request for the answer. Requires user authorization to run the task. Read access by default; write must be explicitly authorized.',
      inputSchema: {
        harness: z.enum(['claude', 'codex']),
        project: z.string().min(1),
        message: z.string().min(1).max(64000),
        write: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => invoke({ method: 'start', ...args }),
  );
  server.registerTool(
    'send_to_session',
    {
      description:
        'Send a task or question to an existing session, including external Codex App Server sessions and Claude sessions with the Pacifico channel enabled, keeping its existing context and permissions. Busy or disconnected sessions reject the message. Requires user authorization. Never retry a request with unknown delivery automatically.',
      inputSchema: { session: z.string(), message: z.string().min(1).max(64000), socket: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => invoke({ method: 'send', ...args }),
  );
  server.registerTool(
    'list_sessions',
    {
      description:
        'List sessions connected to the local Pacifico session host, including native ID, project, availability and edit access. Archived sessions are not live connections.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => invoke({ method: 'list' }),
  );
  server.registerTool(
    'read_request',
    {
      description:
        'Read the status and response for one start_session or send_to_session request. A running request is not a completed task.',
      inputSchema: { request: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => invoke({ method: 'result', ...args }),
  );
}
