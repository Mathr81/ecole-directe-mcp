import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { startHttpServer, type StartHttpServerResult } from '../../src/transport/http.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';

const TOKEN = 'test-token-0123456789abcdef';

let running: StartHttpServerResult | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

async function start(env: Record<string, string | undefined> = {}) {
  const fake = new FakeEcoleDirecteClient();
  fake.timetable = [
    { id: '1', subject: 'MATHS', teacher: null, room: null, start: '2026-09-09 08:00', end: '2026-09-09 09:00', cancelled: false },
  ];
  const config = loadConfig(
    { MCP_AUTH_TOKEN: TOKEN, MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '0', ...env },
    { readOnlyDefault: true },
  );
  const sessionBox = createSessionBox(makeSession(), async () => {});
  running = await startHttpServer({ client: fake, sessionBox, config });
  return { fake, port: running.port };
}

function rpc(method: string, params: unknown = {}, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json<T>(): T;
}

/**
 * Raw node:http rather than fetch, for two reasons: fetch silently drops a
 * custom `Host` header (it is a forbidden header), which is exactly what the
 * DNS-rebinding test needs to set; and its keep-alive pool reuses a dead
 * socket when the OS hands a later test the same ephemeral port.
 */
function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        agent: false,
      },
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

describe('HTTP transport', () => {
  it('serves /health without a token, and says nothing about the account', async () => {
    const { port } = await start();

    const response = await request(port, '/health');

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', sessionExists: true });
    expect(response.body).not.toContain('jdupont');
  });

  it('rejects an MCP request with no token', async () => {
    const { port } = await start();

    const response = await request(port, '/mcp', { method: 'POST', headers: MCP_HEADERS, body: rpc('initialize') });

    expect(response.status).toBe(401);
  });

  it('rejects an MCP request with the wrong token', async () => {
    const { port } = await start();

    const response = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: 'Bearer nope' },
      body: rpc('initialize'),
    });

    expect(response.status).toBe(401);
  });

  it('answers a real MCP call with the right token', async () => {
    const { port } = await start();

    const response = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.json<{ result?: { serverInfo?: { name?: string } } }>().result?.serverInfo?.name).toBe(
      'ecoledirecte-mcp',
    );
  });

  it('does not hand out a session id, since the transport is stateless', async () => {
    const { port } = await start();

    const response = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      }),
    });

    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  it('rejects a Host header that is not allowlisted', async () => {
    // DNS rebinding: a page in the user's browser resolving its own domain to
    // the tailnet address would otherwise reach this server with the attacker's
    // Host header.
    const { port } = await start();

    const response = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}`, Host: 'evil.example.com' },
      body: rpc('initialize'),
    });

    expect(response.status).toBe(403);
  });

  it('404s any other path', async () => {
    const { port } = await start();

    expect((await request(port, '/')).status).toBe(404);
    expect((await request(port, '/admin')).status).toBe(404);
  });

  it('refuses to start without a configured token', async () => {
    const config = loadConfig({ MCP_AUTH_TOKEN: '', MCP_HTTP_PORT: '0' }, { readOnlyDefault: true });
    const sessionBox = createSessionBox(makeSession(), async () => {});

    await expect(
      startHttpServer({ client: new FakeEcoleDirecteClient(), sessionBox, config }),
    ).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });

  it('defaults to read-only over HTTP, so mark_homework_done is not exposed', async () => {
    const { port } = await start();

    const response = await request(port, '/mcp', {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: rpc('tools/list'),
    });
    const body = response.json<{ result?: { tools?: Array<{ name: string }> } }>();
    const names = (body.result?.tools ?? []).map((tool) => tool.name);

    expect(names).toContain('get_timetable');
    expect(names).not.toContain('mark_homework_done');
  });
});
