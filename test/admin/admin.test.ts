import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { writeSession } from '../../src/store/sessionStore.js';
import { startHttpServer, type StartHttpServerResult } from '../../src/transport/http.js';
import type { MultiUser } from '../../src/users/multiUser.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { buildMultiUser, PerUserFake } from '../fakes/multiUserFake.js';

const PASSPHRASE = 'phrase-admin-de-test';
let dir = '';
let running: StartHttpServerResult | null = null;
let mu: MultiUser;
let port = 0;
let fake: PerUserFake;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(method: string, path: string, options: { cookie?: string; form?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : undefined;
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function login(): Promise<string> {
  const reply = await send('POST', '/admin/login', { form: { passphrase: PASSPHRASE } });
  expect(reply.status).toBe(303);
  return String((reply.headers['set-cookie'] as string[])[0]).split(';')[0];
}

async function addUser(username: string, status: 'approved' | 'pending', displayName = username) {
  const userId = mu.users.idFor(username);
  await mu.users.save({
    userId,
    username,
    displayName,
    accountKind: 'E',
    status,
    isOwner: false,
    createdAt: new Date().toISOString(),
    deviceUUID: 'dev',
    session: fake.sessionFor(username),
  });
  return userId;
}

async function start(withOwner = true) {
  if (withOwner) await writeSession(fake.sessionFor('moi'), join(dir, 'session.json'));
  const env = {
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: '0',
    MCP_PUBLIC_URL: 'http://127.0.0.1:1/mcp',
    MCP_OAUTH_PASSPHRASE: PASSPHRASE,
    MCP_OAUTH_STORE_PATH: join(dir, 'oauth.json'),
    SESSION_PATH: join(dir, 'session.json'),
    DOWNLOAD_DIR: join(dir, 'downloads'),
  };
  const built = await buildMultiUser(env, fake);
  mu = built.multiUser;
  running = await startHttpServer(
    { client: fake, sessionBox: createSessionBox(makeSession(), async () => {}), config: built.config },
    { multiUser: mu },
  );
  port = running.port;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-admin-'));
  fake = new PerUserFake();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = null;
  await rm(dir, { recursive: true, force: true });
});

describe('admin page', () => {
  it('GET /admin without cookie shows the login form, not the list', async () => {
    await start();
    await addUser('ami', 'pending', 'Ami Secret');

    const page = await send('GET', '/admin');

    expect(page.status).toBe(200);
    expect(page.body).toContain('name="passphrase"');
    expect(page.body).not.toContain('Ami Secret');
  });

  it('wrong passphrase 401; the 11th failure is 429', async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      expect((await send('POST', '/admin/login', { form: { passphrase: 'non' } })).status).toBe(401);
    }
    expect((await send('POST', '/admin/login', { form: { passphrase: PASSPHRASE } })).status).toBe(429);
  });

  it('login sets an HttpOnly SameSite=Strict cookie scoped to /admin', async () => {
    await start();
    const reply = await send('POST', '/admin/login', { form: { passphrase: PASSPHRASE } });
    const cookie = String((reply.headers['set-cookie'] as string[])[0]);
    expect(cookie).toMatch(/^ed_admin=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/admin');
    expect(reply.headers.location).toBe('/admin');
  });

  it('actions without a valid or with a forged cookie are 401 and change nothing', async () => {
    await start();
    const id = await addUser('ami', 'pending');
    const valid = await login();
    const forged = valid.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    const expired = `ed_admin=1000.${valid.split('.')[1]}`;

    for (const cookie of [undefined, forged, expired]) {
      expect((await send('POST', `/admin/users/${id}/approve`, { cookie, form: {} })).status).toBe(401);
    }
    expect((await mu.users.get(id))!.status).toBe('pending');
  });

  it('approve turns a pending user into approved', async () => {
    await start();
    const id = await addUser('ami', 'pending');
    const reply = await send('POST', `/admin/users/${id}/approve`, { cookie: await login(), form: {} });
    expect(reply.status).toBe(303);
    const record = (await mu.users.get(id))!;
    expect(record.status).toBe('approved');
    expect(record.approvedAt).toBeTruthy();
    expect(mu.activity.events()).toMatchObject([{ type: 'approved', userId: id }]);
  });

  it('reject removes a pending user', async () => {
    await start();
    const id = await addUser('ami', 'pending');
    await send('POST', `/admin/users/${id}/reject`, { cookie: await login(), form: {} });
    expect(await mu.users.get(id)).toBeNull();
  });

  it('revoke removes an approved user and their tokens', async () => {
    await start();
    const id = await addUser('ami', 'approved');
    const { accessToken } = await mu.oauthStore.issueTokens({ clientId: 'c', scopes: [], userId: id }, 60_000, 60_000);
    await send('POST', `/admin/users/${id}/revoke`, { cookie: await login(), form: {} });
    expect(await mu.users.get(id)).toBeNull();
    expect(await mu.oauthStore.findAccessToken(accessToken)).toBeUndefined();
    // Anonymous on purpose: the user asked to leave no trace.
    expect(mu.activity.events()).toEqual([expect.objectContaining({ type: 'revoked' })]);
    expect(mu.activity.events()[0].userId).toBeUndefined();
  });

  it('the owner cannot be revoked', async () => {
    await start();
    const owner = (await mu.users.owner())!;
    await send('POST', `/admin/users/${owner.userId}/revoke`, { cookie: await login(), form: {} });
    expect(await mu.users.get(owner.userId)).not.toBeNull();
  });

  it('an unknown user id just redirects', async () => {
    await start();
    expect((await send('POST', '/admin/users/inconnu/approve', { cookie: await login(), form: {} })).status).toBe(303);
  });

  it('a display name with HTML is escaped in the list', async () => {
    await start();
    await addUser('ami', 'pending', '<script>alert(1)</script>');
    const page = await send('GET', '/admin', { cookie: await login() });
    expect(page.body).toContain('&lt;script&gt;');
    expect(page.body).not.toContain('<script>alert');
    expect(page.body).toContain('en attente');
    expect(page.body).toContain('propriétaire');
  });

  it('the list shows the no-owner banner when there is no owner', async () => {
    await start(false);
    const page = await send('GET', '/admin', { cookie: await login() });
    expect(page.body).toContain('Aucun propriétaire');
  });

  it('logout clears the cookie', async () => {
    await start();
    const reply = await send('POST', '/admin/logout', { cookie: await login(), form: {} });
    expect(reply.status).toBe(303);
    expect(String((reply.headers['set-cookie'] as string[])[0])).toMatch(/ed_admin=;/);
  });

  it('the people page, a person and the journal need the cookie', async () => {
    await start();
    const id = await addUser('ami', 'approved', 'Ami Secret');
    for (const path of ['/admin/users', `/admin/users/${id}`, '/admin/activity']) {
      const page = await send('GET', path);
      expect(page.body).toContain('name="passphrase"');
      expect(page.body).not.toContain('Ami Secret');
    }
  });

  it('the dashboard counts tool calls and lists pending requests first', async () => {
    await start();
    const id = await addUser('ami', 'approved', 'Ami');
    await addUser('nouveau', 'pending', 'Nouveau Venu');
    await mu.activity.record({ type: 'tool', userId: id, tool: 'get_grades', ok: true, ms: 80 });
    await mu.activity.record({ type: 'tool', userId: id, tool: 'get_grades', ok: false, ms: 80 });

    const page = await send('GET', '/admin', { cookie: await login() });

    expect(page.body).toContain('Une demande attend ta réponse');
    expect(page.body).toContain('Nouveau Venu');
    expect(page.body).toContain('50 %');
    expect(page.body).toContain('<svg class="chart"');
  });

  it('a person page shows their activity; an unknown id is 404', async () => {
    await start();
    const id = await addUser('ami', 'approved', 'Ami');
    await mu.activity.record({ type: 'tool', userId: id, tool: 'get_homework', ok: true, ms: 80 });
    const cookie = await login();

    const page = await send('GET', `/admin/users/${id}`, { cookie });
    expect(page.status).toBe(200);
    expect(page.body).toContain('a consulté ses devoirs');

    expect((await send('GET', `/admin/users/${'0'.repeat(64)}`, { cookie })).status).toBe(404);
  });

  it('the journal filters by kind and by person', async () => {
    await start();
    const a = await addUser('a', 'approved', 'Alice');
    const b = await addUser('b', 'approved', 'Bob');
    await mu.activity.record({ type: 'tool', userId: a, tool: 'get_grades', ok: true });
    await mu.activity.record({ type: 'tool', userId: b, tool: 'get_timetable', ok: false });
    await mu.activity.record({ type: 'login', userId: a });
    const cookie = await login();

    const errors = await send('GET', '/admin/activity?kind=errors', { cookie });
    expect(errors.body).toContain('emploi du temps');
    expect(errors.body).not.toContain('a consulté ses notes');

    const alice = await send('GET', `/admin/activity?user=${a}`, { cookie });
    expect(alice.body).toContain("s'est connecté");
    expect(alice.body).not.toContain('emploi du temps');
  });

  it('an action sends the owner back to the page it came from, never elsewhere', async () => {
    await start();
    const cookie = await login();
    const one = await addUser('un', 'pending');
    const two = await addUser('deux', 'pending');

    const back = await send('POST', `/admin/users/${one}/approve`, { cookie, form: { back: '/admin/users' } });
    expect(back.headers.location).toBe('/admin/users');

    const evil = await send('POST', `/admin/users/${two}/approve`, { cookie, form: { back: 'https://evil.example/admin' } });
    expect(evil.headers.location).toBe('/admin');
  });
});
