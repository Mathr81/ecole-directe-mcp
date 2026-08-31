import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetClassLife(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_class_life',
    {
      title: 'Vie de classe',
      description: "Récupère le cahier de texte / vie de la classe de l'élève.",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const summary = await context.client.getClassLife(session);
        return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
      }),
  );
}
