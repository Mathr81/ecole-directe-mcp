import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Client,
  InvalidCredentials,
  Invalid2FAKey,
  Require2FA,
  type Account,
  type Credential,
} from '@blockshub/blocksdirecte';
import { InvalidCredentialsError, InvalidTwoFactorAnswerError, PossiblyExpiredSessionError, mapCaughtError, wrapCall } from './errors.js';
import { mapClassLife, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable } from './mappers.js';
import type { EcoleDirecteClient, LoginCredentials, Session, TwoFactorChallenge } from './types.js';

type AccountKindValue = Parameters<InstanceType<typeof Client>['auth']['refreshToken']>[1];

function assertPresent<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new PossiblyExpiredSessionError(
      `École Directe (${context}) a renvoyé une réponse vide — session probablement expirée.`,
    );
  }
  return value;
}

interface PatchableModule {
  credentials: Credential;
  moduleName?: string;
  isModuleAvailableForSelectedAccount(): boolean;
}

const PATCHED_MODULE_KEYS = ['marks', 'homework', 'timetable', 'schoollife', 'classlife'] as const;

/**
 * Works around a confirmed bug in @blockshub/blocksdirecte@0.0.9-alpha:
 * Modules.prototype.isModuleAvailableForSelectedAccount calls
 * this.getSelectedAccount(), which calls back into
 * isModuleAvailableForSelectedAccount() — unconditional recursion for
 * every module built with a moduleName (these five; timeline/downloader
 * are unaffected). This reimplements the intended check directly against
 * the credentials the caller already validated, with no recursion.
 * Remove once fixed upstream.
 */
export function patchBrokenModuleAvailabilityCheck(client: Client): void {
  for (const key of PATCHED_MODULE_KEYS) {
    const moduleInstance = client[key] as unknown as PatchableModule;
    moduleInstance.isModuleAvailableForSelectedAccount = function (this: PatchableModule): boolean {
      const account: Account = this.credentials.accounts[this.credentials.selectedAccounts];
      return account.modules.some((entry) => entry.code === this.moduleName);
    };
  }
}

/**
 * Works around a confirmed bug in @blockshub/blocksdirecte@0.0.9-alpha:
 * AuthModules.prototype.refreshToken only recognizes response codes 250
 * and 505 — any other code (including an expired/invalid session) falls
 * through to its success path with an empty accounts array and an empty
 * token, indistinguishable from a real success without this check.
 * Remove once fixed upstream.
 */
export function assertRefreshSucceeded(result: { token: string; accounts: unknown[] }): void {
  if (!result.token || result.accounts.length === 0) {
    throw new PossiblyExpiredSessionError(
      "École Directe a refusé le rafraîchissement de session (bug connu de @blockshub/blocksdirecte : les codes d'expiration ne sont pas détectés et un résultat vide est traité comme un succès).",
    );
  }
}

const credentialCache = new Map<string, Credential>();

function accountFromCredential(credential: Credential) {
  const account = credential.accounts[credential.selectedAccounts];
  if (!account) throw new Error('École Directe credential has no selected account');
  return account;
}

function sessionFromCredential(
  base: { username: string; deviceUUID: string; cnKey?: string; cvKey?: string },
  credential: Credential,
): Session {
  const account = accountFromCredential(credential);
  return {
    username: base.username,
    deviceUUID: base.deviceUUID,
    accountId: String(account.id),
    accountKind: account.typeCompte,
    displayName: `${account.prenom} ${account.nom}`.trim(),
    accessToken: credential.token ?? account.accessToken,
    cnKey: base.cnKey,
    cvKey: base.cvKey,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshCredential(session: Session): Promise<Credential> {
  const bootstrap = new Client();
  const result = await bootstrap.auth.refreshToken(
    session.username,
    session.accountKind as AccountKindValue,
    session.accessToken,
    session.cnKey,
    session.cvKey,
    session.deviceUUID,
  );
  assertRefreshSucceeded(result);
  return { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
}

async function ensureClient(session: Session): Promise<Client> {
  const cached = credentialCache.get(session.username);
  if (cached) {
    const client = new Client(cached);
    patchBrokenModuleAvailabilityCheck(client);
    return client;
  }
  const refreshed = await refreshCredential(session);
  credentialCache.set(session.username, refreshed);
  const client = new Client(refreshed);
  patchBrokenModuleAvailabilityCheck(client);
  return client;
}

export function createBlocksDirecteClient(): EcoleDirecteClient {
  return {
    async login({ username, password, deviceUUID }: LoginCredentials): Promise<Session | TwoFactorChallenge> {
      const client = new Client();
      try {
        const result = await client.auth.loginUsername(username, password, undefined, undefined, true, deviceUUID);
        const credential: Credential = { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
        credentialCache.set(username, credential);
        return sessionFromCredential({ username, deviceUUID }, credential);
      } catch (error) {
        if (error instanceof Require2FA) {
          const question = await client.auth.get2FAQuestion(error.token);
          return { token: error.token, question: question.question, propositions: question.propositions };
        }
        if (error instanceof InvalidCredentials) {
          throw new InvalidCredentialsError(505, error.message);
        }
        throw mapCaughtError(error);
      }
    },

    async completeTwoFactor(
      challenge: TwoFactorChallenge,
      answer: string,
      { username, password, deviceUUID }: LoginCredentials,
    ): Promise<Session> {
      const client = new Client();
      let cnCv;
      try {
        cnCv = await client.auth.send2FAQuestion(answer, challenge.token);
      } catch (error) {
        if (error instanceof Invalid2FAKey) throw new InvalidTwoFactorAnswerError(0, error.message);
        throw error;
      }
      const result = await client.auth.loginUsername(username, password, cnCv.cn, cnCv.cv, true, deviceUUID);
      const credential: Credential = { token: result.token, accounts: result.accounts, selectedAccounts: 0 };
      credentialCache.set(username, credential);
      return sessionFromCredential({ username, deviceUUID, cnKey: cnCv.cn, cvKey: cnCv.cv }, credential);
    },

    async refreshSession(session: Session): Promise<Session> {
      return wrapCall(async () => {
        const credential = await refreshCredential(session);
        credentialCache.set(session.username, credential);
        return sessionFromCredential(session, credential);
      });
    },

    async getGrades(session, schoolYear) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const marks = assertPresent(await client.marks.getMark(schoolYear), 'getMark');
        return mapGrades(marks.notes);
      });
    },

    async getHomework(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const upcoming = assertPresent(await client.homework.getUpcomingHomework(), 'getUpcomingHomework');
        const dates = Object.keys(upcoming).filter((date) => date >= fromDate && date <= toDate);
        const perDate: Array<{ date: string; response: Awaited<ReturnType<typeof client.homework.getHomeworksForDate>> }> = [];
        for (const date of dates) {
          const response = assertPresent(await client.homework.getHomeworksForDate(date), 'getHomeworksForDate');
          perDate.push({ date, response });
        }
        return mapHomework(perDate);
      });
    },

    async markHomeworkDone(session, homeworkId, done) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const id = Number(homeworkId);
        if (done) {
          await client.homework.markHomeworkAsDone(id);
        } else {
          await client.homework.markHomeworkAsUndone(id);
        }
      });
    },

    async getTimetable(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const courses = assertPresent(
          await client.timetable.getTimetableBetweenDates(new Date(fromDate), new Date(toDate)),
          'getTimetableBetweenDates',
        );
        return mapTimetable(courses);
      });
    },

    async getSchoolLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapSchoolLife(assertPresent(await client.schoollife.getSchoolLife(), 'getSchoolLife'));
      });
    },

    async getClassLife(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapClassLife(assertPresent(await client.classlife.getClassLife(), 'getClassLife'));
      });
    },

    async getTimeline(session) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        return mapTimeline(assertPresent(await client.timeline.getPersonalTimeline(), 'getPersonalTimeline'));
      });
    },

    async downloadDocument(session, fileId, fileType, destinationDir) {
      return wrapCall(async () => {
        const client = await ensureClient(session);
        const stream = await client.downloader.getStream(Number(fileId), fileType);
        if (!stream) throw new Error(`École Directe returned no content for document ${fileId}`);
        await mkdir(destinationDir, { recursive: true });
        const filename = fileId;
        const path = join(destinationDir, filename);
        await pipeline(Readable.fromWeb(stream), createWriteStream(path));
        const { size } = await stat(path);
        return { path, filename, mimeType: 'application/octet-stream', sizeBytes: size };
      });
    },

    async getAuthStatus(session) {
      return {
        sessionExists: session !== null,
        username: session?.username ?? null,
        lastRefreshAt: session?.updatedAt ?? null,
        lastErrorCode: null,
      };
    },
  };
}
