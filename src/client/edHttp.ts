/**
 * JSON calls to École Directe over direct HTTP, for the endpoints
 * `@blockshub/blocksdirecte` has no module for (messaging, documents).
 */
import { EcoleDirecteApiError, mapErrorCode } from './errors.js';
import type { Session } from './types.js';

const BASE_URL = 'https://api.ecoledirecte.com';

/** Must match `edAuth`'s constants: École Directe binds a token to its User-Agent. */
const API_VERSION = '8.0.0';
const USER_AGENT =
  'BlocksDirecte/1.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148  EDMOBILE v' +
  API_VERSION;

interface Envelope {
  code: number;
  message?: string;
  data?: unknown;
}

export async function post(session: Session, path: string, payload: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('v', API_VERSION);
  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({ data: JSON.stringify(payload) }).toString(),
    headers: {
      'Content-Type': 'x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'X-Token': session.token,
    },
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new EcoleDirecteApiError(
      response.status,
      `École Directe a répondu ${response.status} ${response.statusText} sur ${path}.`,
    );
  }
  const body = (await response.json()) as Envelope;
  if (body.code !== 200) {
    // Unlike the data modules of @blockshub/blocksdirecte, this code path does
    // see École Directe's numeric code — so 520/525 become a real
    // TokenExpiredError and withAutoRefresh can retry properly.
    throw mapErrorCode(body.code, body.message || `École Directe a renvoyé le code ${body.code}.`);
  }
  return body.data;
}
