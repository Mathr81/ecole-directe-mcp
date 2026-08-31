import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { createCachingClient } from '../../src/client/cachingClient.js';

describe('createCachingClient', () => {
  it('caches getGrades results within the TTL', async () => {
    const fake = new FakeEcoleDirecteClient();
    let now = 0;
    const client = createCachingClient(fake, { ttlMs: 1000, now: () => now });
    const session = makeSession();

    await client.getGrades(session);
    await client.getGrades(session);

    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('refetches after the TTL expires', async () => {
    const fake = new FakeEcoleDirecteClient();
    let now = 0;
    const client = createCachingClient(fake, { ttlMs: 1000, now: () => now });
    const session = makeSession();

    await client.getGrades(session);
    now = 2000;
    await client.getGrades(session);

    expect(fake.callCounts.getGrades).toBe(2);
  });

  it('does not cache getSchoolLife (only grades/homework/timetable are cached)', async () => {
    const fake = new FakeEcoleDirecteClient();
    const client = createCachingClient(fake);
    const session = makeSession();

    await client.getSchoolLife(session);
    await client.getSchoolLife(session);

    expect(fake.callCounts.getSchoolLife).toBe(2);
  });

  it('serializes outbound calls so the underlying client never sees overlapping calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.callDelayMs = 20;
    const client = createCachingClient(fake);
    const session = makeSession();

    await Promise.all([client.getSchoolLife(session), client.getClassLife(session)]);

    expect(fake.globalMaxConcurrent).toBe(1);
  });

  it('invalidates cached homework after markHomeworkDone', async () => {
    const fake = new FakeEcoleDirecteClient();
    const client = createCachingClient(fake);
    const session = makeSession();

    await client.getHomework(session, '2026-01-01', '2026-01-31');
    await client.markHomeworkDone(session, '42', true);
    await client.getHomework(session, '2026-01-01', '2026-01-31');

    expect(fake.callCounts.getHomework).toBe(2);
  });

  it('shares a single in-flight fetch between concurrent cache-miss callers instead of fetching twice', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.callDelayMs = 20;
    const client = createCachingClient(fake);
    const session = makeSession();

    await Promise.all([client.getGrades(session), client.getGrades(session)]);

    expect(fake.callCounts.getGrades).toBe(1);
  });
});
