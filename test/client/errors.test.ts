import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import {
  AuthenticationRequiredError,
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
    const client = withAutoRefresh(fake, box);

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
    const client = withAutoRefresh(fake, box);

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
    const client = withAutoRefresh(fake, box);

    await expect(client.getGrades(box.get()!)).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(fake.callCounts.getGrades).toBe(1);
    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('deduplicates concurrent refreshes triggered by parallel calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.queueFailure('getHomework', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ accessToken: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = withAutoRefresh(fake, box);

    await Promise.all([
      client.getGrades(box.get()!),
      client.getHomework(box.get()!, '2026-01-01', '2026-01-31'),
    ]);

    expect(fake.callCounts.refreshSession).toBe(1);
  });

  it('reuses an already-fresher session from the box instead of refreshing again', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ accessToken: 'stale-token' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    const box = createSessionBox(makeSession({ accessToken: 'fresh-token' }), async () => {});
    const client = withAutoRefresh(fake, box);

    const grades = await client.getGrades(staleSession);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.refreshSession).toBeUndefined();
  });
});
