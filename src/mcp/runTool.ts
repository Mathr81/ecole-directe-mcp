import { AuthenticationRequiredError, EcoleDirecteApiError } from '../client/errors.js';
import type { SessionBox } from '../client/sessionBox.js';
import type { Session } from '../client/types.js';

export interface ToolResult {
  // The MCP SDK's CallToolResult type (from zod's `.loose()`) carries an
  // implicit string index signature, so a value typed only with the fields
  // below isn't structurally assignable to it under `strict` without this —
  // see the Task 11 report for details. No behavioral change: this widens
  // the type, it doesn't add or require any actual extra property.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export async function runTool(
  sessionBox: SessionBox,
  fn: (session: Session) => Promise<ToolResult>,
): Promise<ToolResult> {
  const session = sessionBox.get();
  if (!session) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: "Aucune session École Directe active. Lance `ecoledirecte-mcp login` dans un terminal, puis relance le serveur.",
        },
      ],
    };
  }
  try {
    return await fn(session);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
    if (error instanceof EcoleDirecteApiError) {
      return {
        isError: true,
        content: [{ type: 'text', text: `École Directe a renvoyé une erreur (code ${error.code}) : ${error.message}` }],
      };
    }
    throw error;
  }
}
