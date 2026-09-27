import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { schoolYear } from '../schoolYear.js';

export function registerGetGrades(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_grades',
    {
      title: 'Notes',
      description:
        "Récupère les notes de l'élève pour une année scolaire donnée. `value` est null pour une note " +
        "non chiffrée, dont `status` donne alors le marqueur École Directe (Abs, NE, Disp…). " +
        "`significant: false` signale une note qui ne compte pas dans la moyenne. `subject` retombe sur " +
        "le code matière quand École Directe n'en fournit pas le libellé (fréquent sur les années archivées). " +
        "`period` situe la note dans le semestre ou trimestre ; `classMin`/`classMax` bornent la classe. " +
        "Pour les moyennes, utiliser `get_averages`.",
      inputSchema: {
        schoolYear: schoolYear.describe('Année scolaire, ex: "2025-2026". Par défaut, année courante.'),
      },
    },
    async ({ schoolYear: year }) =>
      runTool(context.sessionBox, async (session) => {
        const grades = await context.client.getGrades(session, year);
        return { content: [{ type: 'text', text: JSON.stringify(grades) }] };
      }),
  );
}
