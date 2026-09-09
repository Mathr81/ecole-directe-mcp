/**
 * OAuth 2.0 authorization server for the public deployment.
 *
 * Why this exists at all: a Claude.ai custom connector is fetched by
 * Anthropic's servers, not by the user's device, so the server has to be
 * reachable from the public internet — Tailscale cannot serve that case. And
 * Claude only supports a fixed bearer header through `static_headers`, which
 * is in beta and scoped to an organization administrator, so OAuth with
 * dynamic client registration is the path that works on any plan.
 *
 * This is a single-account server, so the OAuth "user" is always the owner and
 * consent is a passphrase prompt. Anthropic requires a human in the loop —
 * a pure machine-to-machine `client_credentials` grant is not supported.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { renderConsentPage } from './consentPage.js';
import { OAuthStore, digest, newSecret } from './store.js';

export const CONSENT_PATH = '/oauth/consent';

const AUTHORIZATION_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** A wrong passphrase this many times burns the pending request. */
const MAX_PASSPHRASE_ATTEMPTS = 5;

export const SUPPORTED_SCOPES = ['ecoledirecte:read', 'offline_access'];

interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
  attempts: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  // Digest both sides first: timingSafeEqual throws on a length mismatch, and
  // padding would leak the expected length through timing.
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}

export interface OAuthProviderOptions {
  store: OAuthStore;
  /** Passphrase shown on the consent screen; the owner's only credential. */
  passphrase: string;
  /** Exact MCP endpoint URL, used as the RFC 8707 resource identifier. */
  resourceUrl: string;
  now?: () => number;
}

export class EcoleDirecteOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly now: () => number;

  constructor(private readonly options: OAuthProviderOptions) {
    this.now = options.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.options.store;
    return {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: async (client) => {
        // Claude registers a fresh client on every new connection (DCR), so
        // this is expected to be called more than once over time.
        const full = {
          ...client,
          client_id: newSecret(),
          client_id_issued_at: Math.floor(this.now() / 1000),
        } as OAuthClientInformationFull;
        await store.saveClient(full);
        return full;
      },
    };
  }

  private prunePending(): void {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }

  /** Step 1: show the consent screen instead of redirecting straight back. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prunePending();
    const pendingId = newSecret();
    this.pending.set(pendingId, {
      clientId: client.client_id,
      clientName: client.client_name ?? 'Un client MCP',
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? SUPPORTED_SCOPES,
      state: params.state,
      resource: params.resource?.href,
      expiresAt: this.now() + PENDING_TTL_MS,
      attempts: 0,
    });
    this.renderConsent(res, pendingId);
  }

  private renderConsent(res: Response, pendingId: string, error?: string): void {
    const entry = this.pending.get(pendingId);
    res
      .status(error ? 401 : 200)
      .set('Content-Type', 'text/html; charset=utf-8')
      // The consent screen must never be cached: it carries a one-shot id.
      .set('Cache-Control', 'no-store')
      .send(
        renderConsentPage({
          pendingId,
          clientName: entry?.clientName ?? 'Un client MCP',
          consentPath: CONSENT_PATH,
          error,
        }),
      );
  }

  /**
   * Step 2: the owner submitted the consent form. On success this redirects
   * back to the client with `code` and `state`, as OAuth 2.1 requires.
   */
  async handleConsent(res: Response, pendingId: string, passphrase: string): Promise<void> {
    this.prunePending();
    const entry = this.pending.get(pendingId);
    if (!entry) {
      res.status(400).set('Content-Type', 'text/html; charset=utf-8').send(
        renderConsentPage({
          pendingId: '',
          clientName: 'Un client MCP',
          consentPath: CONSENT_PATH,
          error: 'Demande expirée ou inconnue. Relance la connexion depuis Claude.',
        }),
      );
      return;
    }

    if (!passphrase || !constantTimeEquals(passphrase, this.options.passphrase)) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_PASSPHRASE_ATTEMPTS) {
        this.pending.delete(pendingId);
        this.renderConsent(res, pendingId, 'Trop de tentatives. Relance la connexion depuis Claude.');
        return;
      }
      this.renderConsent(res, pendingId, 'Phrase secrète incorrecte.');
      return;
    }

    this.pending.delete(pendingId);
    const code = await this.options.store.createCode(
      {
        clientId: entry.clientId,
        codeChallenge: entry.codeChallenge,
        redirectUri: entry.redirectUri,
        scopes: entry.scopes,
        resource: entry.resource,
      },
      AUTHORIZATION_CODE_TTL_MS,
    );

    const target = new URL(entry.redirectUri);
    target.searchParams.set('code', code);
    if (entry.state !== undefined) target.searchParams.set('state', entry.state);
    res.redirect(target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = await this.options.store.peekCode(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code.');
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // PKCE itself is verified by the SDK's token handler against the challenge
    // returned above; this consumes the code so it can never be replayed.
    const entry = await this.options.store.consumeCode(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code.');
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    return this.issue(entry.clientId, entry.scopes, entry.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = await this.options.store.consumeRefreshToken(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      // Must be exactly `invalid_grant`: Claude treats other codes as a hard
      // failure rather than a signal to re-authorize.
      throw new InvalidGrantError('Unknown or expired refresh token.');
    }
    // A refresh may narrow the scopes but never widen them.
    const granted = scopes?.length ? scopes.filter((scope) => entry.scopes.includes(scope)) : entry.scopes;
    return this.issue(entry.clientId, granted, entry.resource);
  }

  private async issue(clientId: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const { accessToken, refreshToken, expiresInSeconds } = await this.options.store.issueTokens(
      { clientId, scopes, resource },
      ACCESS_TOKEN_TTL_MS,
      REFRESH_TOKEN_TTL_MS,
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresInSeconds,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = await this.options.store.findAccessToken(token);
    if (!entry) throw new InvalidTokenError('Unknown or expired access token.');
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: new URL(entry.resource ?? this.options.resourceUrl),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.options.store.revoke(request.token);
  }
}
