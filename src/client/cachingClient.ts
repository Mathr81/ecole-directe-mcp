import type { EcoleDirecteClient, Session } from './types.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CachingClientOptions {
  ttlMs?: number;
  now?: () => number;
}

export function createCachingClient(
  client: EcoleDirecteClient,
  options: CachingClientOptions = {},
): EcoleDirecteClient {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry<unknown>>();
  const inFlight = new Map<string, Promise<unknown>>();
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function invalidatePrefix(prefix: string): void {
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now()) {
      return Promise.resolve(entry.value);
    }
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = enqueue(fn)
      .then((value) => {
        cache.set(key, { value, expiresAt: now() + ttlMs });
        inFlight.delete(key);
        return value;
      })
      .catch((error) => {
        inFlight.delete(key);
        throw error;
      });
    inFlight.set(key, promise);
    return promise;
  }

  return {
    login: (credentials) => enqueue(() => client.login(credentials)),
    completeTwoFactor: (challenge, answer, credentials) => enqueue(() => client.completeTwoFactor(challenge, answer, credentials)),
    refreshSession: (session: Session) => enqueue(() => client.refreshSession(session)),
    getGrades: (session, schoolYear) => cached(`grades:${session.username}:${schoolYear ?? ''}`, () => client.getGrades(session, schoolYear)),
    getHomework: (session, fromDate, toDate) =>
      cached(`homework:${session.username}:${fromDate}:${toDate}`, () => client.getHomework(session, fromDate, toDate)),
    markHomeworkDone: (session, homeworkId, done) =>
      enqueue(() => client.markHomeworkDone(session, homeworkId, done)).then((result) => {
        invalidatePrefix(`homework:${session.username}:`);
        return result;
      }),
    getTimetable: (session, fromDate, toDate) =>
      cached(`timetable:${session.username}:${fromDate}:${toDate}`, () => client.getTimetable(session, fromDate, toDate)),
    getSchoolLife: (session) => enqueue(() => client.getSchoolLife(session)),
    getClassLife: (session) => enqueue(() => client.getClassLife(session)),
    getTimeline: (session) => enqueue(() => client.getTimeline(session)),
    downloadDocument: (session, fileId, fileType, destinationDir) =>
      enqueue(() => client.downloadDocument(session, fileId, fileType, destinationDir)),
    getAuthStatus: (session) => enqueue(() => client.getAuthStatus(session)),
  };
}
