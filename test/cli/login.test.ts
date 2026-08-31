import { describe, expect, it, vi } from 'vitest';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { runLoginFlow, type LoginIO } from '../../src/cli/login.js';

const credentials = { username: 'jdupont', password: 'secret', deviceUUID: 'device-1' };

describe('runLoginFlow', () => {
  it('returns the session directly when no QCM is required', async () => {
    const fake = new FakeEcoleDirecteClient();
    const io: LoginIO = { chooseAnswer: vi.fn() };

    const session = await runLoginFlow(fake, io, credentials);

    expect(session).toEqual(fake.session);
    expect(io.chooseAnswer).not.toHaveBeenCalled();
  });

  it('prompts for the QCM answer and completes login when required', async () => {
    const fake = new FakeEcoleDirecteClient();
    fake.twoFactorChallenge = { token: 't', question: 'Quelle est votre ville ?', propositions: ['Paris', 'Lyon'] };
    fake.session = makeSession({ displayName: 'Jean Dupont' });
    const io: LoginIO = { chooseAnswer: vi.fn().mockResolvedValue('Lyon') };

    const session = await runLoginFlow(fake, io, credentials);

    expect(io.chooseAnswer).toHaveBeenCalledWith('Quelle est votre ville ?', ['Paris', 'Lyon']);
    expect(fake.callCounts.completeTwoFactor).toBe(1);
    expect(session).toEqual(fake.session);
  });
});
