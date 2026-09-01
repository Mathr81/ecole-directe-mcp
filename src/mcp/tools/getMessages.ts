import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetMessages(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_messages',
    {
      title: 'Messagerie — liste',
      description:
        "Liste les messages de la messagerie École Directe. Ne renvoie que les en-têtes : le corps d'un message s'obtient avec `read_message`.",
      inputSchema: {
        folder: z
          .enum(['received', 'sent', 'draft', 'archived'])
          .default('received')
          .describe('Dossier à lister (reçus par défaut)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Nombre maximum de messages'),
      },
    },
    async ({ folder, limit }) =>
      runTool(context.sessionBox, async (session) => {
        const messages = await context.client.getMessages(session, folder, limit);
        return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
      }),
  );
}
