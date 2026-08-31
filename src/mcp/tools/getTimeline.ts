import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetTimeline(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_timeline',
    {
      title: 'Fil d\'actualité',
      description: "Récupère le fil d'actualité personnel de l'élève (notes, absences, documents...).",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const timeline = await context.client.getTimeline(session);
        return { content: [{ type: 'text', text: JSON.stringify(timeline) }] };
      }),
  );
}
