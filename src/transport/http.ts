/**
 * HTTP transport (V2). Meant to run on the VPS and be reached over Tailscale,
 * never published to the open internet — see `DEFAULT_HTTP_HOST` in config.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer, type ToolContext } from '../mcp/server.js';
import { isAuthorized } from './httpAuth.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

export interface StartHttpServerResult {
  server: Server;
  /** The port actually bound — useful when the configured port is 0 (tests). */
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Health check: unauthenticated on purpose, so infrastructure can probe it,
 * and therefore deliberately uninformative — whether a session exists, and
 * nothing that identifies the account or its data.
 */
function handleHealth(context: ToolContext, res: ServerResponse): void {
  sendJson(res, 200, { status: 'ok', sessionExists: context.sessionBox.get() !== null });
}

async function handleMcp(context: ToolContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless: a fresh server and transport per request. There is no
  // server-to-client push to keep alive, and per-request instances avoid
  // request-id collisions between concurrent callers.
  const server = buildServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: context.config.http.allowedHosts,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export async function startHttpServer(context: ToolContext): Promise<StartHttpServerResult> {
  const { host, port, authToken } = context.config.http;
  if (!authToken) {
    throw new Error(
      'MCP_AUTH_TOKEN est vide : le transport HTTP refuse de démarrer sans jeton. ' +
        'Génère-en un avec `openssl rand -hex 32` et mets-le dans MCP_AUTH_TOKEN.',
    );
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === HEALTH_PATH && req.method === 'GET') {
      handleHealth(context, res);
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (!isAuthorized(req.headers.authorization, authToken)) {
      // No hint about why: a caller either has the token or does not.
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    handleMcp(context, req, res).catch((error: unknown) => {
      // stderr only — stdout is not a protocol channel here, but keeping the
      // habit means the same code is safe if it is ever reused under stdio.
      console.error('Erreur pendant le traitement d\'une requête MCP :', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
