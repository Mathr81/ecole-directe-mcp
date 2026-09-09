/**
 * HTTP transport.
 *
 * Two deployments share this code:
 *
 *  - **Tailnet**: reached from the user's own machines, authenticated by a
 *    fixed `MCP_AUTH_TOKEN`, published only on the Tailscale address.
 *  - **Public**: reached by Anthropic's servers so the endpoint can be added
 *    as a Claude.ai custom connector, authenticated by OAuth. A custom
 *    connector is fetched by Anthropic's infrastructure rather than by the
 *    user's device, so a tailnet-only address can never serve that case.
 *
 * Either credential is accepted when both are configured; at least one must
 * be, or the server refuses to start.
 */
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { buildServer, type ToolContext } from '../mcp/server.js';
import { CONSENT_PATH, EcoleDirecteOAuthProvider, SUPPORTED_SCOPES } from '../oauth/provider.js';
import { OAuthStore } from '../oauth/store.js';
import { isAuthorized } from './httpAuth.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

export interface StartHttpServerResult {
  server: Server;
  /** The port actually bound — useful when the configured port is 0 (tests). */
  port: number;
  close(): Promise<void>;
}

async function handleMcp(context: ToolContext, req: Request, res: Response): Promise<void> {
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
  await transport.handleRequest(req, res, req.body);
}

export async function startHttpServer(context: ToolContext): Promise<StartHttpServerResult> {
  const { host, port, authToken } = context.config.http;
  const oauth = context.config.oauth;

  if (!authToken && !oauth.enabled) {
    throw new Error(
      "Le transport HTTP n'a aucun moyen d'authentifier ses appelants. Définis MCP_AUTH_TOKEN " +
        '(`openssl rand -hex 32`) pour un accès par jeton fixe, et/ou MCP_PUBLIC_URL + ' +
        'MCP_OAUTH_PASSPHRASE pour OAuth (connecteur Claude.ai).',
    );
  }

  const app = express();
  // Exactly one hop — Nginx Proxy Manager. `true` would trust any
  // X-Forwarded-For a caller sends, which lets anyone spoof their address and
  // walk straight past the rate limiting the SDK's auth router applies to
  // /authorize, /token and /register.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Health check: unauthenticated on purpose, so infrastructure can probe it,
  // and therefore deliberately uninformative — whether a session exists, and
  // nothing that identifies the account or its data.
  app.get(HEALTH_PATH, (_req, res) => {
    res.json({ status: 'ok', sessionExists: context.sessionBox.get() !== null });
  });

  let oauthGuard: ReturnType<typeof requireBearerAuth> | undefined;

  if (oauth.enabled) {
    const provider = new EcoleDirecteOAuthProvider({
      store: new OAuthStore(oauth.storePath),
      passphrase: oauth.passphrase,
      resourceUrl: oauth.publicUrl,
    });
    const resourceUrl = new URL(oauth.publicUrl);
    const issuerUrl = new URL(resourceUrl.origin);

    app.post(CONSENT_PATH, express.urlencoded({ extended: false }), (req, res, next) => {
      const body = req.body as { pending?: string; passphrase?: string };
      provider.handleConsent(res, body.pending ?? '', body.passphrase ?? '').catch(next);
    });

    // Must be mounted at the application root: it owns /authorize, /token,
    // /register, /revoke and the /.well-known metadata documents.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl: resourceUrl,
        scopesSupported: SUPPORTED_SCOPES,
        resourceName: 'École Directe MCP',
      }),
    );

    oauthGuard = requireBearerAuth({
      verifier: provider,
      // Points Claude at the protected resource metadata from the 401, which
      // is the handshake that tells it where the authorization server is.
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    });
  }

  function authenticate(req: Request, res: Response, next: NextFunction): void {
    // The fixed token short-circuits; anything else falls through to OAuth so
    // Claude still receives a spec-shaped 401 with WWW-Authenticate.
    if (authToken && isAuthorized(req.headers.authorization, authToken)) {
      next();
      return;
    }
    if (oauthGuard) {
      oauthGuard(req, res, next);
      return;
    }
    // No hint about why: a caller either has the token or does not.
    res.status(401).json({ error: 'unauthorized' });
  }

  app.all(MCP_PATH, express.json({ limit: '4mb' }), authenticate, (req, res, next) => {
    handleMcp(context, req, res).catch(next);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    // stderr only — stdout is not a protocol channel here, but keeping the
    // habit means the same code is safe if it is ever reused under stdio.
    console.error('Erreur pendant le traitement d\'une requête HTTP :', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => {
      listening.removeListener('error', reject);
      resolve(listening);
    });
    listening.once('error', reject);
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
