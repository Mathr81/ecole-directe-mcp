import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenExpiredError } from '../../src/client/errors.js';
import { NoSessionError } from '../../src/health/sessionMonitor.js';
import type { DownloadResult, Session } from '../../src/client/types.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { writeSession } from '../../src/store/sessionStore.js';
import { startHttpServer, type StartHttpServerResult } from '../../src/transport/http.js';
import type { MultiUser } from '../../src/users/multiUser.js';
import { buildMultiUser, PerUserFake } from '../fakes/multiUserFake.js';

class DownloadRecordingFake extends PerUserFake {
  destinations: string[] = [];
  override async downloadDocument(_session: Session, _fileId: string, _fileType: string, destinationDir: string): Promise<DownloadResult> {
    this.destinations.push(destinationDir);
    await mkdir(destinationDir, { recursive: true });
    const path = join(destinationDir, 'doc.txt');
    await writeFile(path, 'contenu');
    return { path, filename: 'doc.txt', mimeType: 'text/plain', sizeBytes: 7 };
  }
}

let dir = '';
let running: StartHttpServerResult | null = null;
let fake: DownloadRecordingFake;
let mu: MultiUser;
let port = 0;
const FIXED = 'jeton-tailnet';

function post(path: string, token: string, body: unknown): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
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
    req.end(JSON.stringify(body));
  });
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await post('/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { ...reply, result: reply.status === 200 ? (JSON.parse(reply.body).result as { isError?: boolean; content: Array<{ text: string }> }) : null };
}

async function addUser(username: string, status: 'approved' | 'pending' = 'approved') {
  const userId = mu.users.idFor(username);
  await mu.users.save({
    userId,
    username,
    displayName: username,
    accountKind: 'E',
    status,
    isOwner: false,
    createdAt: new Date().toISOString(),
    deviceUUID: 'dev',
    session: { ...fake.sessionFor(username) },
  });
  const { accessToken } = await mu.oauthStore.issueTokens({ clientId: 'c', scopes: ['ecoledirecte:read'], userId }, 3_600_000, 3_600_000);
  return { userId, token: accessToken };
}

async function start() {
  // Probe for a free port, then bind it so the public URL matches.
  for (const attempt of [0, 1]) {
    const env = {
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(attempt === 0 ? 0 : port),
      MCP_AUTH_TOKEN: FIXED,
      MCP_PUBLIC_URL: `http://127.0.0.1:${attempt === 0 ? 1 : port}/mcp`,
      MCP_OAUTH_PASSPHRASE: 'p',
      MCP_OAUTH_STORE_PATH: join(dir, 'oauth.json'),
      SESSION_PATH: join(dir, 'session.json'),
      DOWNLOAD_DIR: join(dir, 'downloads'),
      MCP_ALLOWED_HOSTS: `127.0.0.1:${attempt === 0 ? 1 : port}`,
    };
    const built = await buildMultiUser(env, fake);
    mu = built.multiUser;
    // No session in the shared context, as in production: only the owner's record has one.
    const server = await startHttpServer(
      { client: fake, sessionBox: createSessionBox(null, async () => {}), config: built.config },
      { multiUser: mu },
    );
    if (attempt === 0) {
      port = server.port;
      await server.close();
    } else running = server;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-mu-http-'));
  fake = new DownloadRecordingFake();
  await writeSession({ ...fake.sessionFor('moi') }, join(dir, 'session.json'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await running?.close();
  running = null;
  await rm(dir, { recursive: true, force: true });
});

describe('multi-user health', () => {
  it('reports whether the owner has a session', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/health', agent: false }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
        .on('error', reject)
        .end();
    });
    expect(JSON.parse(reply)).toMatchObject({ sessionExists: true });
  });

  it('checkOwnerSession runs a real call on the owner session, and fails without an owner', async () => {
    const calls = fake.callCounts.getTimeline ?? 0;
    await mu.checkOwnerSession();
    expect(fake.callCounts.getTimeline).toBe(calls + 1);

    await mu.users.delete((await mu.users.owner())!.userId);
    mu.runtimes.forget(mu.users.idFor('moi'));
    await expect(mu.checkOwnerSession()).rejects.toBeInstanceOf(NoSessionError);
  });
});

describe('multi-user MCP requests', () => {
  it("user A's token only ever reads A's grades", async () => {
    const a = await addUser('a');
    const b = await addUser('b');

    const asA = (await callTool(a.token, 'get_grades')).result!.content[0].text;
    const asB = (await callTool(b.token, 'get_grades')).result!.content[0].text;

    expect(asA).toContain('"label":"a"');
    expect(asA).not.toContain('"label":"b"');
    expect(asB).toContain('"label":"b"');
    expect(asB).not.toContain('"label":"a"');
  });

  it('each tool call lands in the journal with its user, tool, outcome and duration', async () => {
    const a = await addUser('a');
    fake.queueFailure('getTimeline', new Error('boom'));

    await callTool(a.token, 'get_grades');
    await callTool(a.token, 'get_timeline');

    const tools = mu.activity.events().filter((e) => e.type === 'tool');
    expect(tools.map(({ userId, tool, ok }) => ({ userId, tool, ok }))).toEqual([
      { userId: a.userId, tool: 'get_grades', ok: true },
      { userId: a.userId, tool: 'get_timeline', ok: false },
    ]);
    expect(typeof tools[0].ms).toBe('number');
    // Facts only: never the arguments or the result.
    expect(JSON.stringify(tools)).not.toContain('label');
  });

  it('removing a user also erases their journal', async () => {
    const a = await addUser('a');
    await callTool(a.token, 'get_grades');
    await mu.removeUser(a.userId);
    expect(mu.activity.events().some((e) => e.userId === a.userId)).toBe(false);
  });

  it("a pending user's token gets 401 with WWW-Authenticate", async () => {
    const pending = await addUser('attente', 'pending');

    const reply = await callTool(pending.token, 'get_grades');

    expect(reply.status).toBe(401);
    expect(String(reply.headers['www-authenticate'])).toContain('resource_metadata=');
    expect(String(reply.headers['www-authenticate'])).toContain('invalid_token');
  });

  it('a token whose user was removed gets 401 and is revoked', async () => {
    const b = await addUser('b');
    await mu.removeUser(b.userId);

    expect((await callTool(b.token, 'get_grades')).status).toBe(401);
    expect(await mu.oauthStore.findAccessToken(b.token)).toBeUndefined();
  });

  it('the fixed token and a legacy token without userId act as the owner', async () => {
    const legacy = await mu.oauthStore.issueTokens({ clientId: 'c', scopes: ['ecoledirecte:read'] }, 3_600_000, 3_600_000);

    expect((await callTool(FIXED, 'get_grades')).result!.content[0].text).toContain('"label":"moi"');
    expect((await callTool(legacy.accessToken, 'get_grades')).result!.content[0].text).toContain('"label":"moi"');
  });

  it("an expired École Directe session revokes the user's tokens and asks to reconnect", async () => {
    const a = await addUser('a');
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    fake.queueFailure('refreshSession', new TokenExpiredError(526, 'mort'));

    const first = await callTool(a.token, 'get_grades');
    expect(first.result!.isError).toBe(true);
    expect(first.result!.content[0].text).toContain('reconnecte le connecteur');

    expect((await callTool(a.token, 'get_grades')).status).toBe(401);
    expect(mu.activity.events().some((e) => e.type === 'session_lost' && e.userId === a.userId)).toBe(true);
  });

  it("downloads land in the user's folder", async () => {
    const a = await addUser('a');

    const reply = await callTool(a.token, 'download_document', { fileId: '1', fileType: 'FICHIER_CDT' });

    expect(reply.result!.isError).toBeFalsy();
    expect(fake.destinations).toEqual([join(dir, 'downloads', a.userId)]);
  });
});
