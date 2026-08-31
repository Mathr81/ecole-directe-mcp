import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerMarkHomeworkDone(server: McpServer, context: ToolContext): void {
  if (context.config.readOnly) return;
  server.registerTool(
    'mark_homework_done',
    {
      title: 'Marquer un devoir',
      description: 'Marque un devoir comme fait ou non fait.',
      inputSchema: {
        homeworkId: z.string().describe('Identifiant du devoir'),
        done: z.boolean().default(true),
      },
    },
    async ({ homeworkId, done }) =>
      runTool(context.sessionBox, async (session) => {
        await context.client.markHomeworkDone(session, homeworkId, done);
        return { content: [{ type: 'text', text: `Devoir ${homeworkId} marqué comme ${done ? 'fait' : 'non fait'}.` }] };
      }),
  );
}
