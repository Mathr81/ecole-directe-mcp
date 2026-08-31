import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import {
  AuthenticationRequiredError,
  PossiblyExpiredSessionError,
  TokenExpiredError,
  wrapCall,
  withAutoRefresh,
} from '../../src/client/errors.js';

describe('wrapCall', () => {
  it('maps a simulated error carrying a numeric code to a typed EcoleDirecteApiError', async () => {
    const error = Object.assign(new Error('token invalide'), { code: 520 });
    await expect(wrapCall(async () => { throw error; })).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rethrows an error with no discoverable numeric code unchanged', async () => {
    const error = new Error('network down');
    await expect(wrapCall(async () => { throw error; })).rejects.toBe(error);
  });

  it('resolves normally when the wrapped call succeeds', async () => {
    await expect(wrapCall(async () => 42)).resolves.toBe(42);
  });
});

describe('withAutoRefresh', () => {
  it('passes through successful calls without refreshing', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [{ id: '1', subject: 'Maths', label: 'DS', value: 15, scale: 20, date: '2026-01-01', coefficient: 1, classAverage: 10 }];
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBeUndefined();
  });

  it('refreshes once and retries after a TokenExpiredError, then persists the new session', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const persisted: string[] = [];
    const box = createSessionBox(makeSession(), async (session) => { persisted.push(session.accessToken); });
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
    expect(fake.callCounts.getGrades).toBe(2);
    expect(persisted).toEqual(['new-token']);
    expect(box.get()!.accessToken).toBe('new-token');
  });

  it('throws AuthenticationRequiredError without looping when refresh also fails', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.queueFailure('refreshSession', new Error('refresh failed'));
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    await expect(client.getGrades(box.get()!)).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(fake.callCounts.getGrades).toBe(1);
    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('deduplicates concurrent refreshes triggered by parallel calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.queueFailure('getHomework', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const persistCalls: string[] = [];
    const box = createSessionBox(makeSession(), async (session) => { persistCalls.push(session.accessToken); });
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    await Promise.all([
      client.getGrades(box.get()!),
      client.getHomework(box.get()!, '2026-01-01', '2026-01-31'),
    ]);

    expect(fake.callCounts.refreshSession).toBe(1);
    expect(persistCalls).toEqual(['new-token']);
  });

  it('reuses an already-fresher session from the box instead of refreshing again', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ accessToken: 'stale-token' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    const box = createSessionBox(makeSession({ accessToken: 'fresh-token' }), async () => {});
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    const grades = await client.getGrades(staleSession);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBeUndefined();
  });
});

describe('withAutoRefresh — preventive age-based refresh', () => {
  it('proactively refreshes a session older than maxAgeMs before calling fn', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.refreshedSession = makeSession({ accessToken: 'new-token', updatedAt: '2026-01-01T00:10:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getGrades(staleSession);

    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('does not proactively refresh a session younger than maxAgeMs', async () => {
    const fake = new FakeEcoleDirecteClient();
    const freshSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const box = createSessionBox(freshSession, async () => {});
    const now = () => new Date('2026-01-01T00:05:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getGrades(freshSession);

    expect(fake.callCounts.refreshSession).toBeUndefined();
  });

  it('proceeds with the call when a preventive refresh fails, instead of aborting', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.queueFailure('refreshSession', new Error('network blip'));
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    const grades = await client.getGrades(staleSession);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('never refreshes for getAuthStatus, even with a stale session', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const now = () => new Date('2026-01-01T00:30:00.000Z').getTime();
    const client = withAutoRefresh(fake, box, { maxAgeMs: 15 * 60 * 1000, now });

    await client.getAuthStatus(staleSession);

    expect(fake.callCounts.refreshSession).toBeUndefined();
  });
});

describe('withAutoRefresh — PossiblyExpiredSessionError', () => {
  it('treats PossiblyExpiredSessionError the same as TokenExpiredError for reactive retry', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new PossiblyExpiredSessionError());
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box, { maxAgeMs: Number.POSITIVE_INFINITY });

    const grades = await client.getGrades(box.get()!);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBe(1);
  });
});

describe('wrapCall — already-typed errors', () => {
  it('does not re-map an already-typed EcoleDirecteApiError — instanceof identity survives', async () => {
    await expect(
      wrapCall(async () => {
        throw new PossiblyExpiredSessionError();
      }),
    ).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});
