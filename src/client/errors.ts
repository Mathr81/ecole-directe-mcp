import type { SessionBox } from './sessionBox.js';
import type { EcoleDirecteClient, Session } from './types.js';

export class EcoleDirecteApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'EcoleDirecteApiError';
    this.code = code;
  }
}

export class InvalidCredentialsError extends EcoleDirecteApiError {}
export class TokenExpiredError extends EcoleDirecteApiError {}
export class SchoolUnavailableError extends EcoleDirecteApiError {}
export class InvalidTwoFactorAnswerError extends EcoleDirecteApiError {}

export class AuthenticationRequiredError extends Error {
  constructor(
    message = "École Directe session expired and could not be refreshed automatically. Run `ecoledirecte-mcp login` again.",
  ) {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export function mapErrorCode(code: number, message: string): EcoleDirecteApiError {
  switch (code) {
    case 505:
      return new InvalidCredentialsError(code, message);
    case 520:
    case 525:
      return new TokenExpiredError(code, message);
    case 535:
      return new SchoolUnavailableError(code, message);
    default:
      return new EcoleDirecteApiError(code, message);
  }
}

/**
 * Duck-types a thrown value for a numeric error code — this file has no
 * import from @blockshub/blocksdirecte and does not know the real shape
 * of what a failed data call throws (unlike ServerResponse<T>, which is
 * a *success*-path type seen in the library's .d.ts and isn't otherwise
 * relevant here). This is a guess at a plausible shape, unverified
 * against a real expired token — see Task 16. A value that doesn't match
 * (no numeric `.code` or `.response.code`) returns `undefined`, so
 * `wrapCall` rethrows it completely unchanged rather than fabricating an
 * `EcoleDirecteApiError` — see the "rethrows ... unchanged" test above.
 */
export function extractErrorCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const withCode = error as { code?: unknown; response?: { code?: unknown } };
    if (typeof withCode.code === 'number') return withCode.code;
    if (typeof withCode.response?.code === 'number') return withCode.response.code;
  }
  return undefined;
}

export function mapCaughtError(error: unknown): unknown {
  const code = extractErrorCode(error);
  if (code === undefined) return error;
  return mapErrorCode(code, error instanceof Error ? error.message : String(error));
}

export async function wrapCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapCaughtError(error);
  }
}

export function withAutoRefresh(client: EcoleDirecteClient, sessionBox: SessionBox): EcoleDirecteClient {
  let inFlightRefresh: Promise<Session> | null = null;

  async function refreshOnce(staleSession: Session): Promise<Session> {
    const current = sessionBox.get();
    if (current && current.accessToken !== staleSession.accessToken) {
      return current;
    }
    if (!inFlightRefresh) {
      inFlightRefresh = client
        .refreshSession(staleSession)
        .then(async (refreshed) => {
          await sessionBox.set(refreshed);
          return refreshed;
        })
        .finally(() => {
          inFlightRefresh = null;
        });
    }
    return inFlightRefresh;
  }

  async function withRetry<T>(session: Session, fn: (session: Session) => Promise<T>): Promise<T> {
    try {
      return await fn(session);
    } catch (error) {
      if (!(error instanceof TokenExpiredError)) throw error;
      let refreshed: Session;
      try {
        refreshed = await refreshOnce(session);
      } catch {
        throw new AuthenticationRequiredError();
      }
      try {
        return await fn(refreshed);
      } catch (retryError) {
        if (retryError instanceof TokenExpiredError) throw new AuthenticationRequiredError();
        throw retryError;
      }
    }
  }

  return {
    login: (credentials) => client.login(credentials),
    completeTwoFactor: (challenge, answer, credentials) => client.completeTwoFactor(challenge, answer, credentials),
    refreshSession: (session) => client.refreshSession(session),
    getGrades: (session, schoolYear) => withRetry(session, (s) => client.getGrades(s, schoolYear)),
    getHomework: (session, fromDate, toDate) => withRetry(session, (s) => client.getHomework(s, fromDate, toDate)),
    markHomeworkDone: (session, homeworkId, done) => withRetry(session, (s) => client.markHomeworkDone(s, homeworkId, done)),
    getTimetable: (session, fromDate, toDate) => withRetry(session, (s) => client.getTimetable(s, fromDate, toDate)),
    getSchoolLife: (session) => withRetry(session, (s) => client.getSchoolLife(s)),
    getClassLife: (session) => withRetry(session, (s) => client.getClassLife(s)),
    getTimeline: (session) => withRetry(session, (s) => client.getTimeline(s)),
    downloadDocument: (session, fileId, fileType, destinationDir) =>
      withRetry(session, (s) => client.downloadDocument(s, fileId, fileType, destinationDir)),
    getAuthStatus: (session) =>
      session ? withRetry(session, (s) => client.getAuthStatus(s)) : client.getAuthStatus(session),
  };
}
