import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';

export function registerGetClassLife(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_class_life',
    {
      title: 'Vie de classe',
      description:
        "Récupère la rubrique « Vie de la classe » : informations publiées pour la classe par l'équipe " +
        "pédagogique, et commentaires. Ce n'est pas le cahier de textes (devoirs et contenu des séances : " +
        "`get_homework`). `content: null` et `comments: []` signifient que rien n'est publié — c'est ce " +
        "qu'École Directe renvoie, pas une erreur.",
      inputSchema: {},
    },
    async () =>
      runTool(context.sessionBox, async (session) => {
        const summary = await context.client.getClassLife(session);
        return { content: [{ type: 'text', text: JSON.stringify(summary) }] };
      }),
  );
}
