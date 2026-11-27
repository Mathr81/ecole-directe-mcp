import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { startHttpServer, type StartHttpServerResult } from '../../src/transport/http.js';
import { InvalidCredentialsError, SchoolUnavailableError } from '../../src/client/errors.js';
import { writeSession } from '../../src/store/sessionStore.js';
import type { MultiUser } from '../../src/users/multiUser.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { buildMultiUser, PerUserFake } from '../fakes/multiUserFake.js';

const PASSPHRASE = 'ma-phrase-secrete-de-test';
const PASSWORD = 'mot-de-passe-secret';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

let running: StartHttpServerResult | null = null;
let tempDir = '';
/** Rebuilt per test so the advertised metadata matches the bound port. */
let publicUrl = '';
let fake: PerUserFake;
let multiUser: MultiUser;
let webhookCalls: string[] = [];
const fakeFetch = (async (_url: string, init: RequestInit) => {
  webhookCalls.push(JSON.parse(String(init.body)).content as string);
  return new Response(null, { status: 204 });
}) as unknown as typeof fetch;

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
  const probe = await startServer({ MCP_HTTP_PORT: '0', ...extraEnv }, 'http://127.0.0.1:1/mcp');
  const port = probe.port;
  await probe.close();
  publicUrl = `http://127.0.0.1:${port}${'/mcp'}`;
  running = await startServer({ MCP_HTTP_PORT: String(port), ...extraEnv }, publicUrl);
  return { port };
}

async function startServer(env: Record<string, string>, url: string) {
  const built = await buildMultiUser(
    {
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_PASSPHRASE: PASSPHRASE,
      MCP_OAUTH_STORE_PATH: join(tempDir, 'oauth.json'),
      SESSION_PATH: join(tempDir, 'session.json'),
      DOWNLOAD_DIR: join(tempDir, 'downloads'),
      NOTIFY_WEBHOOK_URL: 'https://hook.test/x',
      // The DNS-rebinding guard compares the whole Host header, port included.
      MCP_ALLOWED_HOSTS: new URL(url).host,
      ...env,
    },
    fake,
    fakeFetch,
  );
  multiUser = built.multiUser;
  const context = { client: fake, sessionBox: createSessionBox(makeSession(), async () => {}), config: built.config };
  return startHttpServer(context, { multiUser });
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

async function openLoginPage(port: number, clientId: string, challenge: string, state = 'st-1') {
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
  return pending as string;
}

function postLogin(port: number, pending: string, username: string, password = PASSWORD) {
  return request(port, '/oauth/login', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ pending, username, password }).toString(),
  });
}

/** Runs authorize → École Directe login → code, returning the authorization code. */
async function authorizeAndLogin(port: number, clientId: string, challenge: string, username = 'jdupont', state = 'st-1') {
  const pending = await openLoginPage(port, clientId, challenge, state);
  const login = await postLogin(port, pending, username);
  expect(login.status).toBe(302);
  const location = new URL(String(login.headers.location));
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get('state')).toBe(state);
  return { code: location.searchParams.get('code') as string, pending };
}

/** Full flow down to an access token. */
async function connect(port: number, username = 'jdupont') {
  const clientId = await registerClient(port);
  const { verifier, challenge } = pkce();
  const { code } = await authorizeAndLogin(port, clientId, challenge, username);
  const token = await exchange(port, clientId, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  });
  expect(token.status).toBe(200);
  return token.json<{ access_token: string; refresh_token: string }>().access_token;
}

async function approve(username: string) {
  const record = (await multiUser.users.findByUsername(username))!;
  await multiUser.users.save({ ...record, status: 'approved', approvedAt: new Date().toISOString() });
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
  fake = new PerUserFake();
  webhookCalls = [];
  // The owner, imported from session.json at startup like on the real server.
  await writeSession(makeSession({ username: 'jdupont' }), join(tempDir, 'session.json'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = null;
  await rm(tempDir, { recursive: true, force: true });
});

describe('home page and static files', () => {
  it('the home page gives the address to paste in Claude and the tutorial', async () => {
    const { port } = await start();
    const home = await request(port, '/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toContain('text/html');
    expect(home.body).toContain(`data-copy="${publicUrl}"`);
    expect(home.body).toContain('Le tuto, en 5 étapes');
  });

  it('serves the stylesheet and the fonts, and nothing outside public/', async () => {
    const { port } = await start();
    const css = await request(port, '/static/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect((await request(port, '/static/fonts/figtree-latin.woff2')).status).toBe(200);
    expect((await request(port, '/static/..%2Fpackage.json')).status).toBe(404);
  });
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
    const { code } = await authorizeAndLogin(port, clientId, challenge);

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

  it('rejects wrong École Directe credentials without issuing a code', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    fake.queueFailure('login', new InvalidCredentialsError(505, 'mauvais'));

    const login = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'jdupont', 'mauvais');

    expect(login.status).toBe(401);
    expect(login.headers.location).toBeUndefined();
    expect(login.body).toContain('Identifiant ou mot de passe incorrect.');
    expect(multiUser.activity.events().map((e) => e.type)).toEqual(['login_failed']);
  });

  it('rejects a mismatched PKCE verifier', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    const { challenge } = pkce();
    const { code } = await authorizeAndLogin(port, clientId, challenge);

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
    const { code } = await authorizeAndLogin(port, clientId, challenge);
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
    const { code } = await authorizeAndLogin(port, clientId, challenge);
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
    const { code } = await authorizeAndLogin(port, clientId, challenge);
    const tokens = (
      await exchange(port, clientId, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      })
    ).json<{ access_token: string }>();

    await running?.close();
    running = await startServer({ MCP_HTTP_PORT: String(port) }, publicUrl);

    const call = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(call.status).toBe(200);
  });
});

describe('multi-user login', () => {
  it('the login page names where the code will go, and warns when it is not Claude', async () => {
    const { port } = await start();
    const page = await request(port, `/authorize?${new URLSearchParams({
      client_id: await registerClient(port),
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    })}`);
    expect(page.body).toContain('renvoyé vers <strong>claude.ai</strong>');
    expect(page.body).not.toContain("ce n'est pas Claude");

    const evil = await request(port, '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://evil.example/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const phishing = await request(port, `/authorize?${new URLSearchParams({
      client_id: evil.json<{ client_id: string }>().client_id,
      response_type: 'code',
      redirect_uri: 'https://evil.example/cb',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    })}`);
    expect(phishing.body).toContain('renvoyé vers <strong>evil.example</strong>');
    expect(phishing.body).toContain("ce n'est pas Claude");
  });

  it('a new user gets a pending page, no code, and a webhook', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);

    const login = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');

    expect(login.status).toBe(200);
    expect(login.body).toContain('Demande envoyée');
    expect(login.headers.location).toBeUndefined();
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]).toContain('ami');
    expect(webhookCalls[0]).toContain(`127.0.0.1:${port}/admin`);
    expect((await multiUser.users.findByUsername('ami'))!.status).toBe('pending');
    expect(multiUser.activity.events()).toMatchObject([{ type: 'request', userId: multiUser.users.idFor('ami') }]);
  });

  it('a pending user logging in again sees still pending', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');

    const again = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');

    expect(again.status).toBe(200);
    expect(again.body).toContain('toujours en attente');
    expect(webhookCalls).toHaveLength(1);
  });

  it('an approved user gets a code tied to their userId', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');
    await approve('ami');

    const token = await connect(port, 'ami');

    expect((await multiUser.oauthStore.findAccessToken(token))!.userId).toBe(multiUser.users.idFor('ami'));
    expect(multiUser.activity.events().map((e) => e.type)).toContain('login');
  });

  it('reconnecting an approved user keeps the same userId and both tokens work', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');
    await approve('ami');
    const forget = vi.spyOn(multiUser.runtimes, 'forget');

    const first = await connect(port, 'ami');
    const second = await connect(port, ' AMI ');

    const id = multiUser.users.idFor('ami');
    expect((await multiUser.oauthStore.findAccessToken(first))!.userId).toBe(id);
    expect((await multiUser.oauthStore.findAccessToken(second))!.userId).toBe(id);
    expect((await multiUser.users.list()).filter((u) => u.userId === id)).toHaveLength(1);
    expect(forget).toHaveBeenCalledWith(id);
  });

  it('a revocation during the École Directe login is not undone', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');
    await approve('ami');
    fake.duringLogin = () => multiUser.removeUser(multiUser.users.idFor('ami'));

    const login = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');

    expect(login.headers.location).toBeUndefined();
    expect((await multiUser.users.findByUsername('ami'))?.status ?? null).not.toBe('approved');
  });

  it('an approval during the École Directe login is not undone', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');
    fake.duringLogin = () => approve('ami');

    const login = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');

    expect(login.status).toBe(302);
    expect((await multiUser.users.findByUsername('ami'))!.status).toBe('approved');
  });

  it('a non-student account is refused before any record or webhook', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    fake.accountKindFor = () => '1';
    const before = (await multiUser.users.list()).length;

    const login = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'parent');

    expect(login.status).toBe(403);
    expect(login.body).toContain('Seuls les comptes élèves sont pris en charge');
    expect((await multiUser.users.list()).length).toBe(before);
    expect(webhookCalls).toHaveLength(0);
  });

  it('wrong credentials: 401 and the 6th attempt is blocked without calling École Directe', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    for (let i = 0; i < 5; i++) fake.queueFailure('login', new InvalidCredentialsError(505, 'mauvais'));

    for (let i = 0; i < 5; i++) {
      const attempt = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami', 'x');
      expect(attempt.status).toBe(401);
    }
    const blocked = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami', 'x');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toContain('Trop de tentatives, réessaie plus tard.');
    expect(fake.callCounts.login).toBe(5);
  });

  it('École Directe down: 502 and not counted as a credential failure', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    fake.queueFailure('login', new SchoolUnavailableError(535, 'maintenance'));
    for (let i = 0; i < 5; i++) fake.queueFailure('login', new InvalidCredentialsError(505, 'mauvais'));

    const down = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami');
    expect(down.status).toBe(502);
    expect(down.body).toContain('ne répond pas');
    for (let i = 0; i < 5; i++) {
      const attempt = await postLogin(port, await openLoginPage(port, clientId, pkce().challenge), 'ami', 'x');
      expect(attempt.status).toBe(401);
    }
  });

  it('QCM flow ends with a code for the owner', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    fake.twoFactorChallenge = { token: 't', question: 'Q ?', propositions: ['A', 'B'] };
    const pending = await openLoginPage(port, clientId, pkce().challenge);

    const quiz = await postLogin(port, pending, 'jdupont');
    expect(quiz.status).toBe(200);
    expect(quiz.body).toContain('Q ?');
    expect(quiz.body).toContain('value="A"');
    expect(quiz.body).toContain('value="B"');

    const answer = await request(port, '/oauth/qcm', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ pending, answer: 'A' }).toString(),
    });
    expect(answer.status).toBe(302);
    expect(String(answer.headers.location)).toContain('code=');
  });

  it('QCM on an expired or consumed pending request', async () => {
    const { port } = await start();

    const answer = await request(port, '/oauth/qcm', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ pending: 'inconnu', answer: 'A' }).toString(),
    });

    expect(answer.status).toBe(400);
    expect(answer.body).toContain('Demande expirée');
    expect(fake.callCounts.completeTwoFactor).toBeUndefined();
  });

  it('the password never reaches the OAuth store or the user files', async () => {
    const { port } = await start();
    const clientId = await registerClient(port);
    fake.twoFactorChallenge = { token: 't', question: 'Q ?', propositions: ['A'] };
    const pending = await openLoginPage(port, clientId, pkce().challenge);
    await postLogin(port, pending, 'ami');
    await request(port, '/oauth/qcm', {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ pending, answer: 'A' }).toString(),
    });

    const files = [join(tempDir, 'oauth.json'), ...(await readdir(join(tempDir, 'users'))).map((f) => join(tempDir, 'users', f))];
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(PASSWORD);
  });

  it('OWNER_ED_USERNAME creates the owner on a fresh install', async () => {
    await rm(join(tempDir, 'session.json'));
    const { port } = await start({ OWNER_ED_USERNAME: 'Moi' });

    await connect(port, 'moi');

    const owner = (await multiUser.users.owner())!;
    expect(owner.username).toBe('moi');
    expect(owner.status).toBe('approved');
    expect(webhookCalls).toHaveLength(0);
  });

  it('startHttpServer refuses OAuth without multi-user wiring', async () => {
    const config = loadConfig(
      { MCP_HTTP_PORT: '0', MCP_PUBLIC_URL: 'http://127.0.0.1:1/mcp', MCP_OAUTH_PASSPHRASE: 'p' },
      { readOnlyDefault: true },
    );
    await expect(
      startHttpServer({ client: fake, sessionBox: createSessionBox(makeSession(), async () => {}), config }),
    ).rejects.toThrow(/SESSION_ENCRYPTION_KEY/);
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
