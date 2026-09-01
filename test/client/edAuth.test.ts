import { afterEach, describe, expect, it, vi } from 'vitest';
import { edGet2FAQuestion, edLogin, edRelogin, edSend2FAAnswer } from '../../src/client/edAuth.js';
import {
  InvalidCredentialsError,
  InvalidTwoFactorAnswerError,
  PossiblyExpiredSessionError,
  TokenExpiredError,
  TwoFactorRequiredError,
} from '../../src/client/errors.js';

const account = { id: 12345, typeCompte: 'E', prenom: 'Jean', nom: 'Dupont', accessToken: 'device-credential' };

interface StubResponse {
  body: unknown;
  headers?: Record<string, string>;
  status?: number;
}

/** Records every outgoing request so tests can assert on payload and headers. */
function stubFetch(...responses: StubResponse[]) {
  const calls: Array<{ url: URL; init: RequestInit; payload: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
    const next = responses[calls.length] ?? responses[responses.length - 1];
    const params = new URLSearchParams(String(init.body));
    calls.push({ url, init, payload: JSON.parse(params.get('data') ?? '{}') });
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const loginParams = { username: 'jdupont', password: 'secret', deviceUUID: 'device-uuid-1' };

const reloginParams = {
  username: 'jdupont',
  accountKind: 'E',
  accessToken: 'device-credential',
  deviceUUID: 'device-uuid-1',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edLogin', () => {
  it('returns the session token and the raw account list', async () => {
    stubFetch({ body: { code: 200, token: 'session-token', data: { accounts: [account] } } });

    const result = await edLogin(loginParams);

    expect(result.token).toBe('session-token');
    expect(result.accounts).toEqual([account]);
  });

  it('falls back to the X-Token response header when the body token is empty', async () => {
    // The failure this guards against: @blockshub/blocksdirecte reads only the
    // body field, so an empty one yields a credential with no token and every
    // later call fails with "Token invalide !".
    stubFetch({
      body: { code: 200, token: '', data: { accounts: [account] } },
      headers: { 'x-token': 'header-token' },
    });

    const result = await edLogin(loginParams);

    expect(result.token).toBe('header-token');
  });

  it('sends the pinned API version and User-Agent', async () => {
    // École Directe binds a token to the User-Agent that obtained it, and the
    // data calls go out through BlocksDirecte's own RESTManager — these two
    // strings must keep matching its constants.
    const calls = stubFetch({ body: { code: 200, token: 't', data: { accounts: [account] } } });

    await edLogin(loginParams);

    expect(calls[0].url.searchParams.get('v')).toBe('8.0.0');
    expect((calls[0].init.headers as Record<string, string>)['User-Agent']).toContain('EDMOBILE v8.0.0');
  });

  it('raises TwoFactorRequiredError with the 2FA token from the response header on code 250', async () => {
    stubFetch({ body: { code: 250, message: 'QCM' }, headers: { '2fa-token': 'qcm-token' } });

    const error = await edLogin(loginParams).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TwoFactorRequiredError);
    expect((error as TwoFactorRequiredError).twoFactorToken).toBe('qcm-token');
  });

  it('raises InvalidCredentialsError on code 505', async () => {
    stubFetch({ body: { code: 505, message: 'Mot de passe invalide !' } });

    await expect(edLogin(loginParams)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('omits cn/cv from the payload when no 2FA keys are supplied', async () => {
    const calls = stubFetch({ body: { code: 200, token: 't', data: { accounts: [account] } } });

    await edLogin(loginParams);

    expect(calls[0].payload).not.toHaveProperty('cn');
    expect(calls[0].payload).not.toHaveProperty('cv');
    expect(calls[0].payload.isReLogin).toBe(false);
  });
});

describe('edRelogin', () => {
  it('sends the re-login payload École Directe expects', async () => {
    const calls = stubFetch({ body: { code: 200, token: 'fresh', data: { accounts: [account] } } });

    await edRelogin(reloginParams);

    expect(calls[0].payload).toMatchObject({
      identifiant: 'jdupont',
      isReLogin: true,
      typeCompte: 'E',
      accesstoken: 'device-credential',
      uuid: 'device-uuid-1',
    });
  });

  it('raises TokenExpiredError on code 526', async () => {
    // The bug this replaces: BlocksDirecte's refreshToken recognises only 250
    // and 505, so 526 fell through to its success path and produced an empty
    // credential that looked like a valid login.
    stubFetch({
      body: { code: 526, token: '', message: 'Votre session est invalide ou expirée', data: { accounts: [] } },
    });

    await expect(edRelogin(reloginParams)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('raises PossiblyExpiredSessionError when code 200 carries no usable account', async () => {
    stubFetch({ body: { code: 200, token: 'x', data: { accounts: [] } } });

    await expect(edRelogin(reloginParams)).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });

  it('raises PossiblyExpiredSessionError when code 200 carries no token at all', async () => {
    stubFetch({ body: { code: 200, token: '', data: { accounts: [account] } } });

    await expect(edRelogin(reloginParams)).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});

describe('two-factor endpoints', () => {
  it('decodes the base64 question and propositions', async () => {
    stubFetch({
      body: {
        code: 200,
        data: {
          question: Buffer.from('Votre date de naissance ?', 'utf8').toString('base64'),
          propositions: [
            Buffer.from('01/01/2008', 'utf8').toString('base64'),
            Buffer.from('02/02/2009', 'utf8').toString('base64'),
          ],
        },
      },
    });

    const result = await edGet2FAQuestion('qcm-token');

    expect(result.question).toBe('Votre date de naissance ?');
    expect(result.propositions).toEqual(['01/01/2008', '02/02/2009']);
  });

  it('base64-encodes the answer and returns the cn/cv keys', async () => {
    const calls = stubFetch({ body: { code: 200, data: { cn: 'cn-key', cv: 'cv-key' } } });

    const result = await edSend2FAAnswer('01/01/2008', 'qcm-token');

    expect(calls[0].payload.choix).toBe(Buffer.from('01/01/2008', 'utf8').toString('base64'));
    expect((calls[0].init.headers as Record<string, string>)['2fa-token']).toBe('qcm-token');
    expect(result).toEqual({ cn: 'cn-key', cv: 'cv-key' });
  });

  it('raises InvalidTwoFactorAnswerError on a wrong answer', async () => {
    stubFetch({ body: { code: 505, message: 'Mauvaise réponse' } });

    await expect(edSend2FAAnswer('nope', 'qcm-token')).rejects.toBeInstanceOf(InvalidTwoFactorAnswerError);
  });
});
