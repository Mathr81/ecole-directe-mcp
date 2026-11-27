import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createMultiUser } from '../../src/users/multiUser.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';

let dir = '';
const env = () => ({
  SESSION_PATH: join(dir, 'session.json'),
  DOWNLOAD_DIR: join(dir, 'downloads'),
  MCP_OAUTH_STORE_PATH: join(dir, 'oauth.json'),
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-multi-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('createMultiUser', () => {
  it('refuses to start without an encryption key', async () => {
    await expect(createMultiUser(loadConfig(env()), new FakeEcoleDirecteClient())).rejects.toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it('removeUser deletes the file, the tokens and the download folder', async () => {
    const config = loadConfig({ ...env(), SESSION_ENCRYPTION_KEY: '11'.repeat(32) });
    const mu = await createMultiUser(config, new FakeEcoleDirecteClient());
    const userId = mu.users.idFor('ami');
    await mu.users.save({
      userId,
      username: 'ami',
      displayName: 'Ami',
      accountKind: 'E',
      status: 'approved',
      isOwner: false,
      createdAt: new Date().toISOString(),
      deviceUUID: 'dev',
      session: makeSession({ username: 'ami' }),
    });
    const { accessToken } = await mu.oauthStore.issueTokens({ clientId: 'c', scopes: [], userId }, 60_000, 60_000);
    await mkdir(join(config.downloadDir, userId), { recursive: true });
    await writeFile(join(config.downloadDir, userId, 'bulletin.pdf'), 'x');

    await mu.removeUser(userId);

    expect(await mu.users.get(userId)).toBeNull();
    expect(await mu.oauthStore.findAccessToken(accessToken)).toBeUndefined();
    await expect(stat(join(config.downloadDir, userId))).rejects.toThrow();
  });
});
