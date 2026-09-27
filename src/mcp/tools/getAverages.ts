import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { schoolYear } from '../schoolYear.js';

export function registerGetAverages(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_averages',
    {
      title: 'Moyennes',
      description:
        "Moyennes de l'élève par période (semestres/trimestres, et l'année entière), par matière et " +
        'générale, sur 20. Calculées à partir des notes, parce que l\'établissement ne publie les ' +
        "moyennes qu'une fois la période close : chaque note compte pour note/barème × 20 × coefficient, " +
        'la moyenne générale pondère les matières par leur coefficient, et les notes non chiffrées ou ' +
        'non significatives sont exclues. `classAverageEstimate` applique la même formule aux moyennes ' +
        'de classe de chaque devoir : c\'est une estimation. Une fois la période close (`closed: true`), ' +
        '`officialAverage` et `officialOverall` donnent les chiffres officiels.',
      inputSchema: {
        schoolYear: schoolYear.describe('Année scolaire, ex: "2025-2026". Par défaut, année courante.'),
      },
    },
    async ({ schoolYear: year }) =>
      runTool(context.sessionBox, async (session) => {
        const averages = await context.client.getAverages(session, year);
        return { content: [{ type: 'text', text: JSON.stringify(averages) }] };
      }),
  );
}
