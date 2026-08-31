import { describe, expect, it } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from './FakeEcoleDirecteClient.js';

describe('FakeEcoleDirecteClient', () => {
  it('returns configured fixtures and counts calls', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.grades = [
      { id: '1', subject: 'Maths', label: 'DS', value: 15, scale: 20, date: '2026-01-01', coefficient: 1, classAverage: 10 },
    ];
    const session = makeSession();

    const grades = await fake.getGrades(session);

    expect(grades).toEqual(fake.grades);
    expect(fake.callCounts.getGrades).toBe(1);
  });

  it('throws a queued failure once, then succeeds', async () => {
    const fake = new FakeEcoleDirecteClient();
    const session = makeSession();
    fake.queueFailure('getGrades', new Error('boom'));

    await expect(fake.getGrades(session)).rejects.toThrow('boom');
    await expect(fake.getGrades(session)).resolves.toEqual(fake.grades);
    expect(fake.callCounts.getGrades).toBe(2);
  });
});
