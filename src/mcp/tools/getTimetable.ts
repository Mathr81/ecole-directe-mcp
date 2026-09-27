import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { dateRangeError, isoDate } from '../dateRange.js';

export function registerGetTimetable(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_timetable',
    {
      title: 'Emploi du temps',
      description:
        "Récupère l'emploi du temps de l'élève entre deux dates (AAAA-MM-JJ), trié chronologiquement. " +
        "`group` est le code du groupe pour un cours en groupe : plusieurs créneaux simultanés du même " +
        "groupe sont des alternatives (un par professeur ou salle), l'élève n'en suit qu'un, et École " +
        "Directe ne dit pas lequel.",
      inputSchema: {
        fromDate: isoDate('Date de début, AAAA-MM-JJ'),
        toDate: isoDate('Date de fin, AAAA-MM-JJ (incluse)'),
      },
    },
    async ({ fromDate, toDate }) =>
      dateRangeError(fromDate, toDate) ??
      runTool(context.sessionBox, async (session) => {
        const timetable = await context.client.getTimetable(session, fromDate, toDate);
        return { content: [{ type: 'text', text: JSON.stringify(timetable) }] };
      }),
  );
}
