import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetTimetable(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_timetable',
    {
      title: 'Emploi du temps',
      description: "Récupère l'emploi du temps de l'élève entre deux dates (AAAA-MM-JJ).",
      inputSchema: {
        fromDate: z.string().describe('Date de début, AAAA-MM-JJ'),
        toDate: z.string().describe('Date de fin, AAAA-MM-JJ'),
      },
    },
    async ({ fromDate, toDate }) =>
      runTool(context.sessionBox, async (session) => {
        const timetable = await context.client.getTimetable(session, fromDate, toDate);
        return { content: [{ type: 'text', text: JSON.stringify(timetable) }] };
      }),
  );
}
