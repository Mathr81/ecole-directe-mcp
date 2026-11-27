import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthStore } from '../../src/oauth/store.js';

const HOUR = 60 * 60 * 1000;
let dir = '';
let now = Date.parse('2026-11-27T12:00:00.000Z');

function client(id: string, issuedAtMs: number): OAuthClientInformationFull {
  return { client_id: id, client_id_issued_at: Math.floor(issuedAtMs / 1000), redirect_uris: ['https://x/cb'] } as OAuthClientInformationFull;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-oauth-store-'));
  now = Date.parse('2026-11-27T12:00:00.000Z');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('OAuthStore', () => {
  it('issueTokens keeps userId and findAccessToken returns it', async () => {
    const store = new OAuthStore(join(dir, 's.json'), () => now);
    const { accessToken } = await store.issueTokens({ clientId: 'c', scopes: [], userId: 'u1' }, HOUR, 24 * HOUR);
    expect((await store.findAccessToken(accessToken))?.userId).toBe('u1');
  });

  it("revokeUser removes only that user's tokens", async () => {
    const store = new OAuthStore(join(dir, 's.json'), () => now);
    const t1 = await store.issueTokens({ clientId: 'c', scopes: [], userId: 'u1' }, HOUR, 24 * HOUR);
    const t2 = await store.issueTokens({ clientId: 'c', scopes: [], userId: 'u2' }, HOUR, 24 * HOUR);
    await store.revokeUser('u1');
    expect(await store.findAccessToken(t1.accessToken)).toBeUndefined();
    expect(await store.findAccessToken(t2.accessToken)).toBeDefined();
    expect(await store.consumeRefreshToken(t1.refreshToken)).toBeUndefined();
  });

  it('stale unused clients are pruned, used ones are kept', async () => {
    const store = new OAuthStore(join(dir, 's.json'), () => now);
    const registeredAt = now;
    await store.saveClient(client('A', registeredAt));
    await store.saveClient(client('B', registeredAt));
    await store.issueTokens({ clientId: 'B', scopes: [], userId: 'u' }, HOUR, 30 * 24 * HOUR);
    now += 25 * HOUR;
    await store.saveClient(client('C', now));
    expect(await store.getClient('A')).toBeUndefined();
    expect(await store.getClient('B')).toBeDefined();
    expect(await store.getClient('C')).toBeDefined();
  });
});
