/**
 * Persistent state for the OAuth authorization server.
 *
 * It lives on disk (on the Docker volume, next to the session) rather than in
 * memory because Claude registers a client once and then reuses it: losing the
 * registration on a container restart would break the connector until the user
 * removed and re-added it.
 *
 * Tokens and authorization codes are stored as SHA-256 digests. The server
 * only ever needs to check whether a presented value matches, never to read
 * one back, so a leaked store file does not hand out working credentials.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readJsonOrDefault, writeJsonAtomic } from '../store/atomicJson.js';

export interface StoredCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface StoredToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface StoreShape {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, StoredCode>;
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

const EMPTY: StoreShape = { clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} };

export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class OAuthStore {
  private state: StoreShape = { ...EMPTY };
  private loaded = false;
  /** Serialises writes so two concurrent requests can't clobber each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readJsonOrDefault<Partial<StoreShape>>(this.path, {});
    this.state = {
      clients: raw.clients ?? {},
      codes: raw.codes ?? {},
      accessTokens: raw.accessTokens ?? {},
      refreshTokens: raw.refreshTokens ?? {},
    };
    this.loaded = true;
  }

  private prune(): void {
    const now = this.now();
    for (const bucket of [this.state.codes, this.state.accessTokens, this.state.refreshTokens]) {
      for (const [key, entry] of Object.entries(bucket)) {
        if (entry.expiresAt <= now) delete bucket[key];
      }
    }
  }

  private async mutate<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load();
      const result = fn();
      this.prune();
      await writeJsonAtomic(this.path, this.state);
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.load();
    return this.state.clients[clientId];
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.mutate(() => {
      this.state.clients[client.client_id] = client;
    });
  }

  /** Returns the raw code; only its digest is persisted. */
  async createCode(entry: Omit<StoredCode, 'expiresAt'>, ttlMs: number): Promise<string> {
    const code = newSecret();
    await this.mutate(() => {
      this.state.codes[digest(code)] = { ...entry, expiresAt: this.now() + ttlMs };
    });
    return code;
  }

  async peekCode(code: string): Promise<StoredCode | undefined> {
    await this.load();
    const entry = this.state.codes[digest(code)];
    return entry && entry.expiresAt > this.now() ? entry : undefined;
  }

  /** Authorization codes are single use: reading one consumes it. */
  async consumeCode(code: string): Promise<StoredCode | undefined> {
    return this.mutate(() => {
      const key = digest(code);
      const entry = this.state.codes[key];
      delete this.state.codes[key];
      return entry && entry.expiresAt > this.now() ? entry : undefined;
    });
  }

  async issueTokens(entry: Omit<StoredToken, 'expiresAt'>, accessTtlMs: number, refreshTtlMs: number) {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    await this.mutate(() => {
      this.state.accessTokens[digest(accessToken)] = { ...entry, expiresAt: this.now() + accessTtlMs };
      this.state.refreshTokens[digest(refreshToken)] = { ...entry, expiresAt: this.now() + refreshTtlMs };
    });
    return { accessToken, refreshToken, expiresInSeconds: Math.floor(accessTtlMs / 1000) };
  }

  async findAccessToken(token: string): Promise<StoredToken | undefined> {
    await this.load();
    const entry = this.state.accessTokens[digest(token)];
    return entry && entry.expiresAt > this.now() ? entry : undefined;
  }

  /**
   * Consumes a refresh token. The MCP authorization spec requires public
   * clients — which is what DCR registers Claude as — to get a rotated
   * refresh token, so the old one must stop working the moment a new one is
   * handed out.
   */
  async consumeRefreshToken(token: string): Promise<StoredToken | undefined> {
    return this.mutate(() => {
      const key = digest(token);
      const entry = this.state.refreshTokens[key];
      delete this.state.refreshTokens[key];
      return entry && entry.expiresAt > this.now() ? entry : undefined;
    });
  }

  async revoke(token: string): Promise<void> {
    await this.mutate(() => {
      const key = digest(token);
      delete this.state.accessTokens[key];
      delete this.state.refreshTokens[key];
    });
  }
}
