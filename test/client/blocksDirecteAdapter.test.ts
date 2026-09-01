// test/client/blocksDirecteAdapter.test.ts
import { Client, type Account, type Credential } from '@blockshub/blocksdirecte';
import { describe, expect, it } from 'vitest';
import { clientFor, patchBrokenModuleAvailabilityCheck } from '../../src/client/blocksDirecteAdapter.js';
import { AuthenticationRequiredError } from '../../src/client/errors.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

function makeFakeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 12345,
    typeCompte: 'E' as Account['typeCompte'],
    modules: [{ code: 'NOTES', enable: true, ordre: 1, badge: 0, params: {} }],
    profile: { classe: { id: 1, code: 'X', libelle: 'X', estNote: 1 } } as Account['profile'],
    ...overrides,
  } as Account;
}

function makeFakeCredential(account: Account): Credential {
  return { token: 'fake-token', accounts: [account], selectedAccounts: 0 };
}

describe('patchBrokenModuleAvailabilityCheck', () => {
  it('returns the selected account without recursing, for a module present on the account', () => {
    const client = new Client(makeFakeCredential(makeFakeAccount()));
    patchBrokenModuleAvailabilityCheck(client);

    const account = (client.marks as unknown as { getSelectedAccount(): Account }).getSelectedAccount();

    expect(account.id).toBe(12345);
  });

  it('reports a module as unavailable when the account does not list it', () => {
    const client = new Client(makeFakeCredential(makeFakeAccount({ modules: [] })));
    patchBrokenModuleAvailabilityCheck(client);

    const available = (client.marks as unknown as { isModuleAvailableForSelectedAccount(): boolean }).isModuleAvailableForSelectedAccount();

    expect(available).toBe(false);
  });

  it('patches all five affected modules (marks, homework, timetable, schoollife, classlife)', () => {
    const client = new Client(
      makeFakeCredential(
        makeFakeAccount({
          modules: [
            { code: 'NOTES', enable: true, ordre: 1, badge: 0, params: {} },
            { code: 'EDT', enable: true, ordre: 2, badge: 0, params: {} },
            { code: 'CAHIER_DE_TEXTES', enable: true, ordre: 3, badge: 0, params: {} },
            { code: 'VIE_SCOLAIRE', enable: true, ordre: 4, badge: 0, params: {} },
            { code: 'VIE_DE_LA_CLASSE', enable: true, ordre: 5, badge: 0, params: {} },
          ],
        }),
      ),
    );
    patchBrokenModuleAvailabilityCheck(client);

    expect((client.marks as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
    expect((client.homework as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
    expect((client.timetable as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
    expect((client.schoollife as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
    expect((client.classlife as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
  });
});

describe('clientFor', () => {
  it('builds the client from the stored session without any network call', () => {
    const client = clientFor(makeSession({ token: 'token-a', accounts: [makeFakeAccount()] }));

    expect((client.marks as unknown as { getSelectedAccount(): Account }).getSelectedAccount().id).toBe(12345);
  });

  it('reuses the same client for the same token, and builds a new one when it rotates', () => {
    const first = clientFor(makeSession({ token: 'token-b', accounts: [makeFakeAccount()] }));
    const same = clientFor(makeSession({ token: 'token-b', accounts: [makeFakeAccount()] }));
    const afterRotation = clientFor(makeSession({ token: 'token-c', accounts: [makeFakeAccount()] }));

    expect(same).toBe(first);
    expect(afterRotation).not.toBe(first);
  });

  it('unrefs the rate-limit interval so a short-lived process can still exit', () => {
    // BlocksDirecte's RESTManager starts an interval it never keeps a handle
    // to; left ref'd, it keeps the event loop alive forever.
    const realSetInterval = globalThis.setInterval;
    const captured: NodeJS.Timeout[] = [];
    globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
      const timer = realSetInterval(...args);
      captured.push(timer);
      return timer;
    }) as typeof globalThis.setInterval;

    try {
      clientFor(makeSession({ token: 'token-d', accounts: [makeFakeAccount()] }));
    } finally {
      globalThis.setInterval = realSetInterval;
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((timer) => timer.hasRef() === false)).toBe(true);
    for (const timer of captured) clearInterval(timer);
  });

  it('refuses a session with no token or no accounts instead of failing later with "Token invalide"', () => {
    expect(() => clientFor(makeSession({ token: '', accounts: [makeFakeAccount()] }))).toThrow(
      AuthenticationRequiredError,
    );
    expect(() => clientFor(makeSession({ token: 'token-e', accounts: [] }))).toThrow(AuthenticationRequiredError);
  });
});
