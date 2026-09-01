import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from '../mcp/server.js';
import type { ToolContext } from '../mcp/server.js';

export async function startStdioServer(context: ToolContext): Promise<void> {
  const server = buildServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
