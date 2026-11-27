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
 * Multi-user: the consent step is an École Directe login (plus the QCM when
 * asked). A first successful login creates a pending user the owner approves
 * from /admin; only an approved user gets an authorization code, tied to
 * their userId. Anthropic requires a human in the loop anyway — a pure
 * machine-to-machine `client_credentials` grant is not supported.
 */
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidCredentialsError, InvalidTwoFactorAnswerError } from '../client/errors.js';
import type { LoginCredentials, Session, TwoFactorChallenge } from '../client/types.js';
import { RateLimiter } from '../transport/rateLimiter.js';
import type { MultiUser } from '../users/multiUser.js';
import { renderLoginPage, renderMessagePage, renderTwoFactorPage } from './pages.js';
import { newSecret } from './store.js';

export const LOGIN_PATH = '/oauth/login';
export const TWO_FACTOR_PATH = '/oauth/qcm';

const AUTHORIZATION_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
/** Wrong credentials this many times burn the pending request. */
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_PENDING_USERS = 20;
/** Only student accounts for now; family accounts need a child selector first. */
const STUDENT_ACCOUNT_KIND = 'E';

const EXPIRED = 'Demande expirée ou inconnue. Relance la connexion depuis ton IA.';
const RATE_LIMITED = 'Trop de tentatives, réessaie plus tard.';
const ED_DOWN = 'École Directe ne répond pas, réessaie plus tard.';

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
  /** Between the login and the QCM only. The password stays in memory, never on disk. */
  challenge?: TwoFactorChallenge;
  credentials?: LoginCredentials;
}

export interface OAuthProviderOptions {
  multiUser: MultiUser;
  /** Exact MCP endpoint URL, used as the RFC 8707 resource identifier. */
  resourceUrl: string;
  /** Linked from the access-request notification. */
  adminUrl: string;
  now?: () => number;
}

function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export class EcoleDirecteOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly now: () => number;
  private readonly userFailures: RateLimiter;
  private readonly ipAttempts: RateLimiter;

  constructor(private readonly options: OAuthProviderOptions) {
    this.now = options.now ?? Date.now;
    this.userFailures = new RateLimiter(5, 15 * 60 * 1000, this.now);
    this.ipAttempts = new RateLimiter(20, 60 * 60 * 1000, this.now);
  }

  private get store() {
    return this.options.multiUser.oauthStore;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const store = this.store;
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
    this.renderLogin(res, 200, pendingId);
  }

  private renderLogin(res: Response, status: number, pendingId: string, error?: string): void {
    const entry = this.pending.get(pendingId);
    this.send(
      res,
      status,
      renderLoginPage({
        pendingId,
        clientName: entry?.clientName ?? 'Un client MCP',
        redirectHost: entry ? new URL(entry.redirectUri).hostname : '',
        action: LOGIN_PATH,
        error,
      }),
    );
  }

  private renderMessage(res: Response, status: number, title: string, message: string): void {
    this.send(res, status, renderMessagePage({ title, message }));
  }

  private send(res: Response, status: number, html: string): void {
    res
      .status(status)
      .set('Content-Type', 'text/html; charset=utf-8')
      // Never cached: these pages carry a one-shot id.
      .set('Cache-Control', 'no-store')
      .send(html);
  }

  /** Step 2: the login form. Ends on the QCM page, a message page, or a redirect with the code. */
  async handleLogin(
    res: Response,
    input: { pending: string; username: string; password: string; ip: string },
  ): Promise<void> {
    this.prunePending();
    const entry = this.pending.get(input.pending);
    if (!entry) {
      this.renderMessage(res, 400, 'Connexion', EXPIRED);
      return;
    }
    const username = input.username.trim();
    if (!username || !input.password) {
      this.renderLogin(res, 400, input.pending, 'Identifiant et mot de passe requis.');
      return;
    }
    const userKey = normaliseUsername(username);
    if (this.ipAttempts.blocked(input.ip) || this.userFailures.blocked(userKey)) {
      this.renderLogin(res, 429, input.pending, RATE_LIMITED);
      return;
    }
    this.ipAttempts.hit(input.ip);

    const { users, loginClient } = this.options.multiUser;
    const existing = await users.findByUsername(username);
    const credentials: LoginCredentials = {
      username,
      password: input.password,
      deviceUUID: existing?.deviceUUID ?? randomUUID(),
    };

    let result: Session | TwoFactorChallenge;
    try {
      result = await loginClient.login(credentials);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        this.userFailures.hit(userKey);
        entry.attempts += 1;
        if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
          this.pending.delete(input.pending);
          this.renderMessage(res, 401, 'Connexion', 'Trop de tentatives. Relance la connexion depuis ton IA.');
          return;
        }
        this.renderLogin(res, 401, input.pending, 'Identifiant ou mot de passe incorrect.');
        return;
      }
      console.error('Connexion École Directe impossible :', error);
      this.renderLogin(res, 502, input.pending, ED_DOWN);
      return;
    }

    if (!('accessToken' in result)) {
      entry.challenge = result;
      entry.credentials = credentials;
      this.send(
        res,
        200,
        renderTwoFactorPage({
          pendingId: input.pending,
          question: result.question,
          propositions: result.propositions,
          action: TWO_FACTOR_PATH,
        }),
      );
      return;
    }
    await this.onAuthenticated(res, input.pending, entry, result);
  }

  /** Step 2b: the QCM answer. */
  async handleTwoFactor(res: Response, input: { pending: string; answer: string; ip: string }): Promise<void> {
    this.prunePending();
    const entry = this.pending.get(input.pending);
    if (!entry?.challenge || !entry.credentials) {
      this.renderMessage(res, 400, 'Connexion', EXPIRED);
      return;
    }
    if (this.ipAttempts.blocked(input.ip)) {
      this.renderMessage(res, 429, 'Connexion', RATE_LIMITED);
      return;
    }
    this.ipAttempts.hit(input.ip);

    const { challenge, credentials } = entry;
    // Whatever happens next, the password leaves memory with this request.
    delete entry.challenge;
    delete entry.credentials;

    let session: Session;
    try {
      session = await this.options.multiUser.loginClient.completeTwoFactor(challenge, input.answer, credentials);
    } catch (error) {
      this.pending.delete(input.pending);
      if (error instanceof InvalidTwoFactorAnswerError) {
        this.userFailures.hit(normaliseUsername(credentials.username));
        this.renderMessage(res, 401, 'Question de sécurité', 'Réponse incorrecte. Relance la connexion depuis ton IA.');
        return;
      }
      console.error('QCM École Directe impossible :', error);
      this.renderMessage(res, 502, 'Question de sécurité', ED_DOWN);
      return;
    }
    await this.onAuthenticated(res, input.pending, entry, session);
  }

  /** École Directe said yes: decide between a code, a pending page and a refusal. */
  private async onAuthenticated(
    res: Response,
    pendingId: string,
    entry: PendingAuthorization,
    session: Session,
  ): Promise<void> {
    this.pending.delete(pendingId);
    const { users, runtimes, notify, ownerUsername } = this.options.multiUser;

    if (session.accountKind !== STUDENT_ACCOUNT_KIND) {
      this.renderMessage(res, 403, 'Compte non pris en charge', "Seuls les comptes élèves sont pris en charge pour l'instant.");
      return;
    }

    const userId = users.idFor(session.username);
    // Read now, not before the École Directe call: an approval or a revocation
    // made meanwhile from /admin must not be overwritten by a stale copy.
    const existing = await users.get(userId);
    const at = new Date(this.now()).toISOString();
    const fresh = { displayName: session.displayName, accountKind: session.accountKind, deviceUUID: session.deviceUUID, session };

    if (existing?.status === 'approved') {
      await users.save({ ...existing, ...fresh });
      // The cached runtime still holds the previous session.
      runtimes.forget(userId);
      await this.redirectWithCode(res, entry, userId);
      return;
    }

    const isOwnerName = ownerUsername !== '' && users.idFor(ownerUsername) === userId;
    if (isOwnerName && !(await users.owner())) {
      await users.save({
        userId,
        username: session.username,
        ...fresh,
        status: 'approved',
        isOwner: true,
        createdAt: existing?.createdAt ?? at,
        approvedAt: at,
      });
      await this.redirectWithCode(res, entry, userId);
      return;
    }

    if (existing) {
      await users.save({ ...existing, ...fresh });
      this.renderMessage(res, 200, 'Demande en attente', 'Ta demande est toujours en attente de validation.');
      return;
    }

    if ((await users.countPending()) >= MAX_PENDING_USERS) {
      this.renderMessage(res, 503, 'Demande refusée', 'Trop de demandes en attente pour le moment, réessaie plus tard.');
      return;
    }
    await users.save({ userId, username: session.username, ...fresh, status: 'pending', isOwner: false, createdAt: at });
    await notify(`${session.displayName} demande l'accès à École Directe MCP : ${this.options.adminUrl}`);
    this.renderMessage(
      res,
      200,
      'Demande envoyée',
      'Le propriétaire du serveur doit valider ton accès. Une fois validé, relance la connexion depuis ton IA.',
    );
  }

  private async redirectWithCode(res: Response, entry: PendingAuthorization, userId: string): Promise<void> {
    const code = await this.store.createCode(
      {
        clientId: entry.clientId,
        codeChallenge: entry.codeChallenge,
        redirectUri: entry.redirectUri,
        scopes: entry.scopes,
        resource: entry.resource,
        userId,
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
    const entry = await this.store.peekCode(authorizationCode);
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
    const entry = await this.store.consumeCode(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code.');
    }
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }
    return this.issue(entry.clientId, entry.scopes, entry.resource, entry.userId);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = await this.store.consumeRefreshToken(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      // Must be exactly `invalid_grant`: Claude treats other codes as a hard
      // failure rather than a signal to re-authorize.
      throw new InvalidGrantError('Unknown or expired refresh token.');
    }
    // A refresh may narrow the scopes but never widen them.
    const granted = scopes?.length ? scopes.filter((scope) => entry.scopes.includes(scope)) : entry.scopes;
    return this.issue(entry.clientId, granted, entry.resource, entry.userId);
  }

  private async issue(clientId: string, scopes: string[], resource?: string, userId?: string): Promise<OAuthTokens> {
    const { accessToken, refreshToken, expiresInSeconds } = await this.store.issueTokens(
      { clientId, scopes, resource, userId },
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
    const entry = await this.store.findAccessToken(token);
    if (!entry) throw new InvalidTokenError('Unknown or expired access token.');
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: new URL(entry.resource ?? this.options.resourceUrl),
      // null: issued before multi-user mode, hence the owner's.
      extra: { userId: entry.userId ?? null },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.revoke(request.token);
  }
}
