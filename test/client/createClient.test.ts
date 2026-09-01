import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { TokenExpiredError } from '../../src/client/errors.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { createClient } from '../../src/client/createClient.js';

describe('createClient', () => {
  it('applies retry-on-expiry and updates the session box on refresh', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expired'));
    fake.refreshedSession = makeSession({ token: 'new-token' });
    const box = createSessionBox(makeSession(), async () => {});
    const client = createClient(fake, box, { sessionMaxAgeMs: Number.POSITIVE_INFINITY });

    await client.getGrades(box.get()!);

    expect(box.get()!.token).toBe('new-token');
  });

  it('applies caching on top of retry', async () => {
    const fake = new FakeEcoleDirecteClient();
    const box = createSessionBox(makeSession(), async () => {});
    const client = createClient(fake, box, { sessionMaxAgeMs: Number.POSITIVE_INFINITY });

    await client.getGrades(box.get()!);
    await client.getGrades(box.get()!);

    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('threads sessionMaxAgeMs through to the preventive-refresh mechanism', async () => {
    const fake = new FakeEcoleDirecteClient();
    const staleSession = makeSession({ updatedAt: '2026-01-01T00:00:00.000Z' });
    fake.refreshedSession = makeSession({ token: 'new-token', updatedAt: '2026-01-01T00:10:00.000Z' });
    const box = createSessionBox(staleSession, async () => {});
    const client = createClient(fake, box, {
      sessionMaxAgeMs: 15 * 60 * 1000,
      now: () => new Date('2026-01-01T00:30:00.000Z').getTime(),
    });

    await client.getGrades(box.get()!);

    expect(fake.callCounts.refreshSession).toBe(1);
    expect(box.get()!.token).toBe('new-token');
  });
});
