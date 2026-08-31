import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { EcoleDirecteClient } from '../client/types.js';
import type { SessionBox } from '../client/sessionBox.js';
import { registerGetGrades } from './tools/getGrades.js';

export interface ToolContext {
  client: EcoleDirecteClient;
  sessionBox: SessionBox;
  config: Config;
}

export function buildServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'ecoledirecte-mcp', version: '0.1.0' });
  registerGetGrades(server, context);
  return server;
}
