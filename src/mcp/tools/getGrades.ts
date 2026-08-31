import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetGrades(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_grades',
    {
      title: 'Notes',
      description: "Récupère les notes de l'élève pour une année scolaire donnée.",
      inputSchema: {
        schoolYear: z.string().optional().describe('Année scolaire, ex: "2025-2026". Par défaut, année courante.'),
      },
    },
    async ({ schoolYear }) =>
      runTool(context.sessionBox, async (session) => {
        const grades = await context.client.getGrades(session, schoolYear);
        return { content: [{ type: 'text', text: JSON.stringify(grades) }] };
      }),
  );
}
