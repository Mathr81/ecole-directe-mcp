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
        "Cahier de textes entre deux dates (AAAA-MM-JJ) : `homework`, les devoirs à rendre ces jours-là " +
        "(`isTest` signale une interrogation, `givenOn` le jour où il a été donné, `lessonContent` ce " +
        "qui a été fait pendant cette séance), et `lessons`, le contenu des séances de ces jours-là, " +
        "même sans devoir. Les pièces jointes se téléchargent avec `download_document` (leur `id` et " +
        "leur `fileType`). École Directe ne couvre que les dates qu'il liste (observé : de la rentrée " +
        "aux prochaines semaines).",
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
