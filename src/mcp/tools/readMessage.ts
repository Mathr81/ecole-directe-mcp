import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerReadMessage(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'read_message',
    {
      title: 'Messagerie — lire un message',
      description:
        "Récupère le contenu d'un message de la messagerie École Directe, HTML retiré, avec la liste de ses pièces jointes (téléchargeables via `download_document` avec fileType `PIECE_JOINTE`).",
      inputSchema: {
        messageId: z.string().describe('Identifiant du message, tel que renvoyé par `get_messages`'),
      },
    },
    async ({ messageId }) =>
      runTool(context.sessionBox, async (session) => {
        const message = await context.client.getMessage(session, messageId);
        return { content: [{ type: 'text', text: JSON.stringify(message) }] };
      }),
  );
}
