import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetWorkspaces(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_workspaces',
    {
      title: 'Espaces de travail',
      description:
        "Liste les espaces de travail (espaces de classe) visibles par l'élève, ex: \"Philo TG3 2026-27\". " +
        "`member` indique ceux qu'il a rejoints. Pour voir les fichiers (cours, fiches...) d'un espace, " +
        'passer son `id` à `get_workspace_files`.',
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const workspaces = await context.client.getWorkspaces(session);
        return { content: [{ type: 'text', text: JSON.stringify(workspaces) }] };
      }),
  );
}

export function registerGetWorkspaceFiles(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_workspace_files',
    {
      title: "Fichiers d'un espace de travail",
      description:
        "Liste les dossiers et fichiers du cloud d'un espace de travail (cours, fiches, méthodologie...). " +
        "Les dossiers profonds ont `contentsListed: false` : rappeler l'outil avec leur `folder`. " +
        'Pour télécharger et lire un fichier, passer à `download_document` son `fileId`, ' +
        '`fileType: "CLOUD"` et le `workspaceId`.',
      inputSchema: {
        workspaceId: z.number().int().positive().describe('`id` de l\'espace, donné par `get_workspaces`'),
        folder: z
          .string()
          .optional()
          .describe('Dossier à lister, tel que donné par `folder` (ex: "\\\\METHODOLOGIE\\\\Dissertation"). Par défaut, la racine.'),
      },
    },
    async ({ workspaceId, folder }) =>
      runTool(context.sessionBox, async (session) => {
        const entries = await context.client.getWorkspaceFiles(session, workspaceId, folder);
        return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
      }),
  );
}
