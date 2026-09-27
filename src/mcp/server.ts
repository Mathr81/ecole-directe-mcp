import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { EcoleDirecteClient } from '../client/types.js';
import type { SessionBox } from '../client/sessionBox.js';
import type { DownloadLinks } from '../transport/downloadLinks.js';
import { registerGetGrades } from './tools/getGrades.js';
import { registerGetAverages } from './tools/getAverages.js';
import { registerGetDocuments } from './tools/getDocuments.js';
import { registerGetHomework } from './tools/getHomework.js';
import { registerGetTimetable } from './tools/getTimetable.js';
import { registerGetSchoolLife } from './tools/getSchoolLife.js';
import { registerGetClassLife } from './tools/getClassLife.js';
import { registerGetTimeline } from './tools/getTimeline.js';
import { registerGetAuthStatus } from './tools/getAuthStatus.js';
import { registerMarkHomeworkDone } from './tools/markHomeworkDone.js';
import { registerDownloadDocument } from './tools/downloadDocument.js';
import { registerGetMessages } from './tools/getMessages.js';
import { registerReadMessage } from './tools/readMessage.js';

export interface ToolContext {
  client: EcoleDirecteClient;
  sessionBox: SessionBox;
  config: Config;
  /**
   * Set by the HTTP transport only: there the file lands on the server, so
   * `download_document` hands back a temporary link instead of a path the
   * caller cannot open. Under stdio the path is local and is returned as is.
   */
  downloadLinks?: Pick<DownloadLinks, 'issue'>;
}

export function buildServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: 'ecoledirecte-mcp', version: '0.1.0' });
  registerGetGrades(server, context);
  registerGetAverages(server, context);
  registerGetHomework(server, context);
  registerGetTimetable(server, context);
  registerGetSchoolLife(server, context);
  registerGetClassLife(server, context);
  registerGetTimeline(server, context);
  registerGetAuthStatus(server, context);
  registerMarkHomeworkDone(server, context);
  registerGetDocuments(server, context);
  registerDownloadDocument(server, context);
  registerGetMessages(server, context);
  registerReadMessage(server, context);
  return server;
}
