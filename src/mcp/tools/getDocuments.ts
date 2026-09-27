import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { schoolYear } from '../schoolYear.js';

export function registerGetDocuments(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_documents',
    {
      title: 'Documents',
      description:
        "Liste les documents de l'élève : bulletins, certificats de scolarité, documents de vie " +
        "scolaire, factures. Les bulletins n'apparaissent qu'une fois la période close ; ceux des " +
        'années passées se trouvent en passant `schoolYear`. Pour télécharger un document, passer ' +
        'son `id`, son `fileType` et son `schoolYear` à `download_document`.',
      inputSchema: {
        schoolYear: schoolYear.describe('Année scolaire archivée, ex: "2025-2026". Par défaut, année courante.'),
      },
    },
    async ({ schoolYear: year }) =>
      runTool(context.sessionBox, async (session) => {
        const documents = await context.client.getDocuments(session, year);
        return { content: [{ type: 'text', text: JSON.stringify(documents) }] };
      }),
  );
}
