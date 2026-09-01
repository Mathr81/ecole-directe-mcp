// test/client/blocksDirecteAdapter.test.ts
import { Client, type Account, type Credential } from '@blockshub/blocksdirecte';
import { describe, expect, it } from 'vitest';
import { assertRefreshSucceeded, patchBrokenModuleAvailabilityCheck } from '../../src/client/blocksDirecteAdapter.js';
import { PossiblyExpiredSessionError } from '../../src/client/errors.js';

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

describe('assertRefreshSucceeded', () => {
  it('throws PossiblyExpiredSessionError when the result has an empty token and no accounts', () => {
    expect(() => assertRefreshSucceeded({ token: '', accounts: [] })).toThrow(PossiblyExpiredSessionError);
  });

  it('throws when accounts is empty even if a token is present', () => {
    expect(() => assertRefreshSucceeded({ token: 'x', accounts: [] })).toThrow(PossiblyExpiredSessionError);
  });

  it('does not throw when both token and a non-empty accounts array are present', () => {
    expect(() => assertRefreshSucceeded({ token: 'x', accounts: [{}] })).not.toThrow();
  });
});
