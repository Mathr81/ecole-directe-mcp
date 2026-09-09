import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { startHttpServer, type StartHttpServerResult } from '../../src/transport/http.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';

const PASSPHRASE = 'ma-phrase-secrete-de-test';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let running: StartHttpServerResult | null = null;
let tempDir = '';
/** Rebuilt per test so the advertised metadata matches the bound port. */
let publicUrl = '';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T>(): T;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers ?? {}, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json<T>(): T {
              return JSON.parse(body) as T;
            },
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function start(extraEnv: Record<string, string> = {}) {
  // Bind an ephemeral port first, then restart on that same port so the
  // advertised issuer and resource URLs match where the server really is.
  const probe = await startHttpServer(buildContext({ MCP_HTTP_PORT: '0', ...extraEnv }, 'http://127.0.0.1:1/mcp'));
  const port = probe.port;
  await probe.close();
  publicUrl = `http://127.0.0.1:${port}${'/mcp'}`;
  running = await startHttpServer(buildContext({ MCP_HTTP_PORT: String(port), ...extraEnv }, publicUrl));
  return { port };
}

function buildContext(env: Record<string, string>, url: string) {
  const config = loadConfig(
    {
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_PASSPHRASE: PASSPHRASE,
      MCP_OAUTH_STORE_PATH: join(tempDir, 'oauth.json'),
      // The DNS-rebinding guard compares the whole Host header, port included.
      MCP_ALLOWED_HOSTS: new URL(url).host,
      ...env,
    },
    { readOnlyDefault: true },
  );
  return { client: new FakeEcoleDirecteClient(), sessionBox: createSessionBox(makeSession(), async () => {}), config };
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(port: number): Promise<string> {
  const response = await request(port, '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(response.status).toBe(201);
  return response.json<{ client_id: string }>().client_id;
}

/** Runs authorize → consent → code, returning the authorization code. */
async function authorizeAndConsent(port: number, clientId: string, challenge: string, state = 'st-1') {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: 'ecoledirecte:read offline_access',
  });
  const page = await request(port, `/authorize?${query}`);
  expect(page.status).toBe(200);
  const pending = /name="pending" value="([^"]+)"/.exec(page.body)?.[1];
  expect(pending).toBeTruthy();

  const consent = await request(port, '/oauth/consent', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ pending: pending as string, passphrase: PASSPHRASE }).toString(),
  });
  expect(consent.status).toBe(302);
  const location = new URL(String(consent.headers.location));
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get('state')).toBe(state);
  return { code: location.searchParams.get('code') as string, pending: pending as string };
}

async function exchange(port: number, clientId: string, body: Record<string, string>) {
  return request(port, '/token', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ client_id: clientId, ...body }).toString(),
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ed-oauth-'));
});

afterEach(async () => {
  await running?.close();
  running = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe('OAuth discovery', () => {
  it('advertises protected resource metadata matching the MCP URL exactly', async () => {
    // Claude compares this against the URL the user typed, path included.
    const { port } = await start();

    const response = await request(port, '/.well-known/oauth-protected-resource/mcp');

    expect(response.status).toBe(200);
    const body = response.json<{ resource: string; authorization_servers: string[] }>();
    expect(body.resource).toBe(publicUrl);
    expect(body.authorization_servers[0]).toContain(`127.0.0.1:${port}`);
  });

  it('advertises S256 PKCE and dynamic client registration', async () => {
    const { port } = await start();

    const body = (await request(port, '/.well-known/oauth-authorization-server')).json<{
      code_challenge_methods_supported: string[];
      registration_endpoint?: string;
      grant_types_supported: string[];
      scopes_supported: string[];
    }>();

    expect(body.code_challenge_methods_supported).toContain('S256');
    expect(body.registration_endpoint).toBeTruthy();
    expect(body.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    // Claude only asks for a refresh token when offline_access is advertised.
    expect(body.scopes_supported).toContain('offline_access');
  });

  it('answers an unauthenticated MCP request with a 401 pointing at the metadata', async () => {
    // Without this handshake Claude never learns where the authorization
    // server is and the connection fails with "Couldn't reach the MCP server".
    const { port } = await start();

    const response = await request(port, '/mcp', { method: 'POST', headers: MCP_HEADERS, body: '{}' });

    expect(response.status).toBe(401);
    expect(String(response.headers['www-authenticate'])).toContain('resource_metadata=');
  });
});

describe('OAuth authorization code flow', () => {
  it('runs end to end and yields a token that works on /mcp', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { verifier, challenge } = pkce();
    const { code } = await authorizeAndConsent(port, clientId, challenge);

    const token = await exchange(port, clientId, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });

    expect(token.status).toBe(200);
    const tokens = token.json<{ access_token: string; refresh_token: string; token_type: string }>();
    expect(tokens.token_type).toBe('Bearer');

    const call = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(call.status).toBe(200);
    expect(call.json<{ result: { tools: unknown[] } }>().result.tools.length).toBeGreaterThan(0);
  });

  it('rejects a wrong passphrase without issuing a code', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { challenge } = pkce();
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st',
    });
    const page = await request(port, `/authorize?${query}`);
    const pending = /name="pending" value="([^"]+)"/.exec(page.body)?.[1] as string;

    const consent = await request(port, '/oauth/consent', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ pending, passphrase: 'mauvaise' }).toString(),
    });

    expect(consent.status).toBe(401);
    expect(consent.headers.location).toBeUndefined();
    expect(consent.body).toContain('incorrecte');
  });

  it('rejects a mismatched PKCE verifier', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { challenge } = pkce();
    const { code } = await authorizeAndConsent(port, clientId, challenge);

    const token = await exchange(port, clientId, {
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT_URI,
    });

    expect(token.status).toBe(400);
  });

  it('burns the authorization code after one use', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { verifier, challenge } = pkce();
    const { code } = await authorizeAndConsent(port, clientId, challenge);
    const body = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI };

    expect((await exchange(port, clientId, body)).status).toBe(200);
    expect((await exchange(port, clientId, body)).status).toBe(400);
  });
});

describe('OAuth refresh', () => {
  it('rotates the refresh token and invalidates the previous one', async () => {
    // The MCP authorization spec requires rotation for public clients, which
    // is what dynamic client registration makes Claude.
    const { port } = await start();
    const clientId = await registerClient(port);
    const { verifier, challenge } = pkce();
    const { code } = await authorizeAndConsent(port, clientId, challenge);
    const first = (
      await exchange(port, clientId, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      })
    ).json<{ refresh_token: string }>();

    const refreshed = await exchange(port, clientId, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const second = refreshed.json<{ refresh_token: string; access_token: string }>();
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await exchange(port, clientId, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    });
    expect(replay.status).toBe(400);
  });

  it('survives a restart, so a container recreation does not break the connector', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { verifier, challenge } = pkce();
    const { code } = await authorizeAndConsent(port, clientId, challenge);
    const tokens = (
      await exchange(port, clientId, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      })
    ).json<{ access_token: string }>();

    await running?.close();
    running = await startHttpServer(buildContext({ MCP_HTTP_PORT: String(port) }, publicUrl));

    const call = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(call.status).toBe(200);
  });
});

describe('coexistence with the fixed token', () => {
  it('accepts either credential when both are configured', async () => {
    const { port } = await start({ MCP_AUTH_TOKEN: 'jeton-tailnet' });
    const call = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: 'Bearer jeton-tailnet' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(call.status).toBe(200);
  });

  it('refuses to start with neither', async () => {
    const config = loadConfig({ MCP_HTTP_PORT: '0' }, { readOnlyDefault: true });

    await expect(
      startHttpServer({
        client: new FakeEcoleDirecteClient(),
        sessionBox: createSessionBox(makeSession(), async () => {}),
        config,
      }),
    ).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });
});
