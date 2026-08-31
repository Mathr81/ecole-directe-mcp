import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerDownloadDocument(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'download_document',
    {
      title: 'Télécharger un document',
      description:
        "Télécharge un document (bulletin, pièce jointe...) depuis École Directe et l'enregistre sur disque. Renvoie le chemin du fichier, pas son contenu.",
      inputSchema: {
        fileId: z.string().describe('Identifiant du fichier École Directe'),
        fileType: z.string().describe('Type de fichier École Directe (ex: "PJ", "CDT")'),
      },
    },
    async ({ fileId, fileType }) =>
      runTool(context.sessionBox, async (session) => {
        const result = await context.client.downloadDocument(session, fileId, fileType, context.config.downloadDir);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }),
  );
}
