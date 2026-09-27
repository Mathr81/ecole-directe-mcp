import { describe, expect, it } from 'vitest';
import { AuthenticationRequiredError, SchoolUnavailableError } from '../../src/client/errors.js';
import { NoSessionError, SessionMonitor } from '../../src/health/sessionMonitor.js';

function monitor(results: Array<Error | null>, failureThreshold = 2) {
  let now = 1_000;
  const queue = [...results];
  const m = new SessionMonitor({
    check: async () => {
      const next = queue.shift() ?? null;
      now += 1_000;
      if (next) throw next;
    },
    intervalMs: 60_000,
    failureThreshold,
    now: () => now,
  });
  return m;
}

describe('SessionMonitor', () => {
  it('starts unknown, then reports ok after a successful check', async () => {
    const m = monitor([null]);

    expect(m.state().status).toBe('unknown');
    await m.runOnce();

    expect(m.state()).toMatchObject({ status: 'ok', reason: null, checkedAt: new Date(2_000).toISOString() });
  });

  it('tolerates a single failure, so a network blip does not raise an alert', async () => {
    const m = monitor([null, new Error('ECONNRESET')]);

    await m.runOnce();
    await m.runOnce();

    expect(m.state().status).toBe('ok');
  });

  it('reports failing after consecutive failures, with the reason and since when', async () => {
    const m = monitor([null, new AuthenticationRequiredError(), new AuthenticationRequiredError(), new AuthenticationRequiredError()]);

    for (let i = 0; i < 4; i++) await m.runOnce();

    expect(m.state()).toMatchObject({
      status: 'failing',
      reason: 'auth_required',
      since: new Date(4_000).toISOString(),
      checkedAt: new Date(5_000).toISOString(),
    });
  });

  it('recovers on the first success', async () => {
    const m = monitor([new SchoolUnavailableError(535, 'maintenance'), new SchoolUnavailableError(535, 'maintenance'), null]);

    await m.runOnce();
    await m.runOnce();
    expect(m.state()).toMatchObject({ status: 'failing', reason: 'school_unavailable' });
    await m.runOnce();

    expect(m.state()).toMatchObject({ status: 'ok', reason: null });
  });

  it('reports a missing session as such', async () => {
    const m = monitor([new NoSessionError(), new NoSessionError()]);

    await m.runOnce();
    await m.runOnce();

    expect(m.state().reason).toBe('no_session');
  });

  it('classifies an unexpected error without exposing its message', async () => {
    const m = monitor([new Error('secret detail'), new Error('secret detail')]);

    await m.runOnce();
    await m.runOnce();

    expect(m.state().reason).toBe('error');
    expect(JSON.stringify(m.state())).not.toContain('secret');
  });

  it('never lets a check error escape, so the timer keeps running', async () => {
    const m = monitor([new Error('boom')]);

    await expect(m.runOnce()).resolves.toBeUndefined();
  });
});
