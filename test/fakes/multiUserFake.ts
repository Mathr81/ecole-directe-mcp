import { loadConfig, type Config } from '../../src/config.js';
import type { Grade, LoginCredentials, Session, TwoFactorChallenge } from '../../src/client/types.js';
import { createMultiUser, type MultiUser } from '../../src/users/multiUser.js';
import { FakeEcoleDirecteClient, makeSession } from './FakeEcoleDirecteClient.js';

export const TEST_ENCRYPTION_KEY = '11'.repeat(32);

/** A fake whose sessions and grades depend on who logged in, to prove users stay apart. */
export class PerUserFake extends FakeEcoleDirecteClient {
  accountKindFor?: (username: string) => string;
  /** Runs while École Directe is "answering" a login, to simulate a concurrent admin action. */
  duringLogin?: () => Promise<void>;

  sessionFor(username: string): Session {
    return makeSession({
      username,
      displayName: username,
      accountId: username,
      accountKind: this.accountKindFor?.(username) ?? 'E',
      token: `tok-${username}`,
      accessToken: `acc-${username}`,
      updatedAt: new Date().toISOString(),
    });
  }

  override async login(credentials: LoginCredentials): Promise<Session | TwoFactorChallenge> {
    const result = await super.login(credentials);
    await this.duringLogin?.();
    return 'accessToken' in result ? { ...this.sessionFor(credentials.username), deviceUUID: credentials.deviceUUID } : result;
  }

  override async completeTwoFactor(
    challenge: TwoFactorChallenge,
    answer: string,
    credentials: LoginCredentials,
  ): Promise<Session> {
    await super.completeTwoFactor(challenge, answer, credentials);
    return { ...this.sessionFor(credentials.username), deviceUUID: credentials.deviceUUID };
  }

  override async getGrades(session: Session, schoolYear?: string): Promise<Grade[]> {
    await super.getGrades(session, schoolYear);
    return [
      {
        id: '1',
        subject: 'Maths',
        subjectCode: 'MATHS',
        period: '',
        periodCode: '',
        type: '',
        label: session.username,
        value: 15,
        status: null,
        significant: true,
        scale: 20,
        date: '2026-11-01',
        coefficient: 1,
        classAverage: null,
        classMin: null,
        classMax: null,
      },
    ];
  }
}

export async function buildMultiUser(
  env: Record<string, string>,
  fake: FakeEcoleDirecteClient,
  fetchImpl?: typeof fetch,
): Promise<{ config: Config; multiUser: MultiUser }> {
  const config = loadConfig({ SESSION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, ...env }, { readOnlyDefault: true });
  return { config, multiUser: await createMultiUser(config, fake, { fetchImpl }) };
}
