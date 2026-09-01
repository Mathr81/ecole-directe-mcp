/**
 * Direct HTTP implementation of École Directe's authentication endpoints.
 *
 * Why this exists instead of `@blockshub/blocksdirecte`'s `auth` module: that
 * module is unusable for our purposes on three counts, each confirmed against
 * the compiled bundle and the real API.
 *
 *  1. It reads the session token only from the response *body*. École Directe
 *     also returns it in the `X-Token` response header, and the body field can
 *     come back empty — in which case the library silently produces a
 *     credential with no token, and every later call fails with "Token
 *     invalide !".
 *  2. `refreshToken` recognises only codes 250 and 505; every other code —
 *     including 526 "Votre session est invalide ou expirée" — falls through to
 *     its success path with an empty token and an empty account list.
 *  3. It writes to **stdout** (`console.log(response.message)`), which
 *     corrupts the JSON-RPC stream of the stdio MCP transport.
 *
 * The data modules of the library are still used (see `blocksDirecteAdapter`);
 * only auth is ours.
 */
import {
  EcoleDirecteApiError,
  InvalidCredentialsError,
  InvalidTwoFactorAnswerError,
  PossiblyExpiredSessionError,
  TwoFactorRequiredError,
  mapErrorCode,
} from './errors.js';
import type { ProviderAccounts } from './types.js';

const BASE_URL = 'https://api.ecoledirecte.com';

/**
 * API version and User-Agent MUST stay byte-identical to the ones
 * `@blockshub/blocksdirecte` sends from its own RESTManager: École Directe
 * binds an issued token to the User-Agent that obtained it, and we obtain the
 * token here but spend it there. Changing either string alone invalidates
 * every token the moment a data call is made.
 */
const API_VERSION = '8.0.0';
const USER_AGENT =
  'BlocksDirecte/1.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148  EDMOBILE v' +
  API_VERSION;

const LOGIN_PATH = '/v3/login.awp';
const TWO_FACTOR_QUESTION_PATH = '/v3/connexion/doubleauth.awp?verbe=get';
const TWO_FACTOR_ANSWER_PATH = '/v3/connexion/doubleauth.awp?verbe=post';

interface Envelope {
  code: number;
  token?: string;
  message?: string;
  data?: unknown;
}

export interface AuthResult {
  /** Session token for the `X-Token` header. */
  token: string;
  /** École Directe's raw account list, kept verbatim for the session file. */
  accounts: ProviderAccounts;
}

export interface LoginParams {
  username: string;
  password: string;
  deviceUUID: string;
  cnKey?: string;
  cvKey?: string;
}

export interface ReloginParams {
  username: string;
  accountKind: string;
  accessToken: string;
  deviceUUID: string;
  cnKey?: string;
  cvKey?: string;
}

function stripUndefined(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function looksBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** École Directe base64-encodes the QCM strings; anything else is passed through. */
function decodeMaybeBase64(value: string): string {
  return looksBase64(value) ? Buffer.from(value, 'base64').toString('utf8') : value;
}

async function post(
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ body: Envelope; headers: Headers }> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('v', API_VERSION);
  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({ data: JSON.stringify(stripUndefined(payload)) }).toString(),
    headers: { 'Content-Type': 'x-www-form-urlencoded', 'User-Agent': USER_AGENT, ...headers },
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new EcoleDirecteApiError(
      response.status,
      `École Directe a répondu ${response.status} ${response.statusText} sur ${path}.`,
    );
  }
  return { body: (await response.json()) as Envelope, headers: response.headers };
}

/**
 * Shared success/error handling for both login and re-login: they hit the same
 * endpoint and return the same envelope. The 2FA token comes back under
 * `2fa-token` on a first login and under `x-token` on a re-login, so both are
 * tried in the order the caller considers most likely.
 */
function readAuthResult(body: Envelope, headers: Headers, twoFactorTokenHeaders: string[]): AuthResult {
  switch (body.code) {
    case 200:
      break;
    case 250:
      throw new TwoFactorRequiredError(
        twoFactorTokenHeaders.map((name) => headers.get(name)).find((value) => Boolean(value)) ?? '',
        body.message || 'École Directe demande une double authentification (QCM).',
      );
    case 505:
      throw new InvalidCredentialsError(505, body.message || 'Identifiant ou mot de passe invalide.');
    default:
      throw mapErrorCode(body.code, body.message || `École Directe a renvoyé le code ${body.code}.`);
  }

  // The token comes back in the body on some responses and only in the
  // X-Token header on others; take whichever is actually populated.
  const token = body.token || headers.get('x-token') || '';
  const accounts = (body.data as { accounts?: unknown[] } | undefined)?.accounts ?? [];
  if (!token || accounts.length === 0) {
    throw new PossiblyExpiredSessionError(
      "École Directe a répondu 200 mais sans jeton ni compte utilisable — session à refaire avec `ecoledirecte-mcp login`.",
    );
  }
  return { token, accounts };
}

export async function edLogin({ username, password, deviceUUID, cnKey, cvKey }: LoginParams): Promise<AuthResult> {
  const { body, headers } = await post(LOGIN_PATH, {
    identifiant: username,
    motdepasse: password,
    isReLogin: false,
    sesouvenirdemoi: true,
    uuid: deviceUUID,
    cn: cnKey,
    cv: cvKey,
  });
  return readAuthResult(body, headers, ['2fa-token', 'x-token']);
}

export async function edRelogin({
  username,
  accountKind,
  accessToken,
  deviceUUID,
  cnKey,
  cvKey,
}: ReloginParams): Promise<AuthResult> {
  const { body, headers } = await post(LOGIN_PATH, {
    identifiant: username,
    uuid: deviceUUID,
    isReLogin: true,
    // École Directe rejects a re-login carrying an empty password with 505;
    // the placeholder is what its own mobile app sends.
    motdepasse: '???',
    typeCompte: accountKind,
    accesstoken: accessToken,
    fa: cnKey && cvKey ? [{ cn: cnKey, cv: cvKey }] : undefined,
  });
  return readAuthResult(body, headers, ['x-token', '2fa-token']);
}

export async function edGet2FAQuestion(
  twoFactorToken: string,
): Promise<{ question: string; propositions: string[] }> {
  const { body } = await post(TWO_FACTOR_QUESTION_PATH, {}, { '2fa-token': twoFactorToken });
  if (body.code !== 200) {
    throw mapErrorCode(body.code, body.message || `École Directe a renvoyé le code ${body.code} pour le QCM.`);
  }
  const data = body.data as { question?: string; propositions?: string[] } | undefined;
  return {
    question: decodeMaybeBase64(data?.question ?? ''),
    propositions: (data?.propositions ?? []).map(decodeMaybeBase64),
  };
}

export async function edSend2FAAnswer(answer: string, twoFactorToken: string): Promise<{ cn: string; cv: string }> {
  const { body } = await post(
    TWO_FACTOR_ANSWER_PATH,
    { choix: Buffer.from(answer, 'utf8').toString('base64') },
    { '2fa-token': twoFactorToken },
  );
  if (body.code === 505) {
    throw new InvalidTwoFactorAnswerError(505, body.message || 'Réponse au QCM invalide.');
  }
  if (body.code !== 200) {
    throw mapErrorCode(body.code, body.message || `École Directe a renvoyé le code ${body.code} pour le QCM.`);
  }
  return body.data as { cn: string; cv: string };
}
