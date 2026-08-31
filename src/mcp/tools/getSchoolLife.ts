import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetSchoolLife(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_school_life',
    {
      title: 'Vie scolaire',
      description: "Récupère les absences, retards, dispenses et sanctions/félicitations de l'élève.",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const entries = await context.client.getSchoolLife(session);
        return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
      }),
  );
}
