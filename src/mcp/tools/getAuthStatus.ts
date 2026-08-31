import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';

export function registerGetAuthStatus(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_auth_status',
    {
      title: 'État de la session',
      description:
        'Diagnostique la session École Directe courante (présence, dernier rafraîchissement) — ' +
        'fonctionne même sans session active, contrairement aux autres outils.',
      inputSchema: {},
    },
    async () => {
      const status = await context.client.getAuthStatus(context.sessionBox.get());
      return { content: [{ type: 'text', text: JSON.stringify(status) }] };
    },
  );
}
