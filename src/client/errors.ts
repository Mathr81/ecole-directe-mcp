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

/**
 * Thrown by the adapter (Task 6) when a BlocksDirecte data method returns
 * null/undefined where it structurally guarantees an object or array — the
 * one observable symptom of an expired token for those methods, since
 * @blockshub/blocksdirecte discards École Directe's numeric error code
 * before it reaches the adapter for anything other than login/refresh/2FA.
 * Treated identically to TokenExpiredError by withAutoRefresh. Do not
 * remove this as "unreachable defensive code" — it is the only signal
 * available for 8 of the 9 data methods. See the plan's Global Constraints
 * for the full rationale.
 */
export class PossiblyExpiredSessionError extends EcoleDirecteApiError {
  constructor(
    message = "École Directe a renvoyé une réponse vide là où un objet ou un tableau était attendu — signe probable d'une session expirée (la librairie ne remonte pas le code d'erreur École Directe pour cet appel).",
  ) {
    super(0, message);
    this.name = 'PossiblyExpiredSessionError';
  }
}

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
 * `EcoleDirecteApiError`.
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
  // Already a typed error we (or the adapter) constructed on purpose — never
  // re-map it through the numeric-code heuristic below, which would strip
  // its specific identity (e.g. PossiblyExpiredSessionError has code 0, a
  // sentinel, and would otherwise collapse into a generic EcoleDirecteApiError).
  if (error instanceof EcoleDirecteApiError || error instanceof AuthenticationRequiredError) return error;
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

export interface WithAutoRefreshOptions {
  /** How old (ms) a session may get before a call proactively refreshes it first. Default 15 minutes — a conservative guess, see Task 16. */
  maxAgeMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export function withAutoRefresh(
  client: EcoleDirecteClient,
  sessionBox: SessionBox,
  options: WithAutoRefreshOptions = {},
): EcoleDirecteClient {
  const maxAgeMs = options.maxAgeMs ?? 15 * 60 * 1000;
  const now = options.now ?? Date.now;
  let inFlightRefresh: Promise<Session> | null = null;

  function isStale(session: Session): boolean {
    return now() - new Date(session.updatedAt).getTime() > maxAgeMs;
  }

  function isRetriableError(error: unknown): boolean {
    return error instanceof TokenExpiredError || error instanceof PossiblyExpiredSessionError;
  }

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
    let currentSession = session;
    if (isStale(currentSession)) {
      try {
        currentSession = await refreshOnce(currentSession);
      } catch {
        // Best-effort: a failed preventive refresh doesn't abort the call —
        // proceed with the session we have. A genuine problem still surfaces
        // via the reactive path below.
      }
    }
    try {
      return await fn(currentSession);
    } catch (error) {
      if (!isRetriableError(error)) throw error;
      let refreshed: Session;
      try {
        refreshed = await refreshOnce(currentSession);
      } catch {
        throw new AuthenticationRequiredError();
      }
      try {
        return await fn(refreshed);
      } catch (retryError) {
        if (isRetriableError(retryError)) throw new AuthenticationRequiredError();
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
    // getAuthStatus never touches the network (Task 6's adapter only reads
    // local session fields for it), so it can never throw a retriable error.
    // Wrapping it in withRetry would only add a pointless proactive-refresh
    // side effect to what's meant to be a safe, always-available diagnostic
    // call — the one tool that must work even when the session is bad.
    getAuthStatus: (session) => client.getAuthStatus(session),
  };
}
