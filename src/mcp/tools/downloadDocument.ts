import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../server.js';
import { runTool } from '../runTool.js';
import { schoolYear } from '../schoolYear.js';
import { extractText } from '../../client/extractText.js';

export function registerDownloadDocument(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'download_document',
    {
      title: 'Télécharger un document',
      description:
        "Télécharge un document (bulletin, pièce jointe...) depuis École Directe et renvoie son texte " +
        "(`text`, pour les PDF, DOCX, TXT et HTML ; sinon `textUnavailableReason` dit pourquoi). " +
        "En local, `path` est le chemin du fichier enregistré. À distance, `downloadUrl` est un lien " +
        "temporaire (valable jusqu'à `downloadUrlExpiresAt`) à donner à l'utilisateur pour qu'il " +
        "récupère le fichier lui-même.",
      inputSchema: {
        fileId: z.string().describe('Identifiant du fichier École Directe'),
        fileType: z
          .string()
          .describe(
            'Type de fichier École Directe : "PIECE_JOINTE" (pièce jointe d\'un message), ' +
              '"FICHIER_CDT" (cahier de textes), "CLOUD" (fichier du cloud), ou le `fileType` donné ' +
              'par `get_documents` pour un bulletin ou un document administratif.',
          ),
        schoolYear: schoolYear.describe(
          "Année scolaire d'un document archivé, telle que donnée par `get_documents` (ex: \"2025-2026\").",
        ),
      },
    },
    async ({ fileId, fileType, schoolYear: year }) =>
      runTool(context.sessionBox, async (session) => {
        const { path, ...file } = await context.client.downloadDocument(
          session,
          fileId,
          fileType,
          context.config.downloadDir,
          year,
        );
        const extracted = await extractText(path, file.mimeType);
        const text = {
          text: extracted.text,
          textTruncated: extracted.truncated,
          ...(extracted.unavailableReason ? { textUnavailableReason: extracted.unavailableReason } : {}),
        };
        // Remote: the server path means nothing to the caller, the link does.
        const link = context.downloadLinks?.issue({ path, filename: file.filename, mimeType: file.mimeType });
        const location = link ? { downloadUrl: link.url, downloadUrlExpiresAt: link.expiresAt } : { path };
        return { content: [{ type: 'text', text: JSON.stringify({ ...location, ...file, ...text }) }] };
      }),
  );
}
