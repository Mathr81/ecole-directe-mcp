import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { dateRangeError, isoDate } from '../dateRange.js';

export function registerGetHomework(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_homework',
    {
      title: 'Devoirs',
      description:
        "Récupère les devoirs de l'élève entre deux dates (AAAA-MM-JJ). " +
        "Ne couvre que les devoirs à venir (non encore échus) : École Directe ne fournit pas de " +
        "listing en masse des devoirs déjà passés, seulement les devoirs futurs.",
      inputSchema: {
        fromDate: isoDate('Date de début, AAAA-MM-JJ'),
        toDate: isoDate('Date de fin, AAAA-MM-JJ (incluse)'),
      },
    },
    async ({ fromDate, toDate }) =>
      dateRangeError(fromDate, toDate) ??
      runTool(context.sessionBox, async (session) => {
        const homework = await context.client.getHomework(session, fromDate, toDate);
        return { content: [{ type: 'text', text: JSON.stringify(homework) }] };
      }),
  );
}
