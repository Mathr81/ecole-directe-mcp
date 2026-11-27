/**
 * Everything the multi-user mode (HTTP with OAuth) needs, built once at
 * startup and shared by the OAuth provider, the MCP route and the admin page.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { EcoleDirecteClient } from '../client/types.js';
import { createNotifier, type Notifier } from '../notify/webhook.js';
import { OAuthStore } from '../oauth/store.js';
import { deriveKeys, type Keys } from '../store/secretBox.js';
import { UserStore } from '../store/userStore.js';
import { syncOwnerFromSessionFile } from './ownerMigration.js';
import { UserRuntimes } from './userRuntimes.js';

export interface MultiUser {
  keys: Keys;
  users: UserStore;
  oauthStore: OAuthStore;
  runtimes: UserRuntimes;
  /** Unwrapped client, for logins: no session to refresh or cache yet. */
  loginClient: EcoleDirecteClient;
  notify: Notifier;
  ownerUsername: string;
  /** Rejected or revoked: record, OAuth tokens, cached runtime and downloads all go. */
  removeUser(userId: string): Promise<void>;
}

export const MISSING_KEY_MESSAGE =
  'Le mode OAuth est multi-utilisateur : définis SESSION_ENCRYPTION_KEY (openssl rand -hex 32).';

export async function createMultiUser(
  config: Config,
  base: EcoleDirecteClient,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<MultiUser> {
  if (!config.multiUser.encryptionKey) throw new Error(MISSING_KEY_MESSAGE);
  const keys = deriveKeys(config.multiUser.encryptionKey);
  const users = new UserStore(config.multiUser.usersDir, keys);
  const oauthStore = new OAuthStore(config.oauth.storePath);
  const runtimes = new UserRuntimes({
    users,
    base,
    sessionMaxAgeMs: config.sessionMaxAgeMs,
    ownerSessionMirrorPath: config.sessionPath,
    onAuthLost: (userId) => oauthStore.revokeUser(userId),
  });

  const outcome = await syncOwnerFromSessionFile(users, config.sessionPath);
  if (outcome === 'imported') console.error('Session du propriétaire importée depuis session.json.');
  if (outcome === 'reimported') console.error('Session du propriétaire mise à jour depuis un session.json plus récent.');
  await users.purgeExpiredPending();

  return {
    keys,
    users,
    oauthStore,
    runtimes,
    loginClient: base,
    notify: createNotifier(config.multiUser.notifyWebhookUrl, options.fetchImpl),
    ownerUsername: config.multiUser.ownerUsername,
    async removeUser(userId) {
      await users.delete(userId);
      await oauthStore.revokeUser(userId);
      runtimes.forget(userId);
      // userId is our own 64-hex id here, never a path fragment from a request.
      if (/^[0-9a-f]{64}$/.test(userId)) {
        await rm(join(config.downloadDir, userId), { recursive: true, force: true });
      }
    },
  };
}
