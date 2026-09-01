import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, type Account, type Credential } from '@blockshub/blocksdirecte';
import { edGet2FAQuestion, edLogin, edRelogin, edSend2FAAnswer, type AuthResult } from './edAuth.js';
import {
  AuthenticationRequiredError,
  PossiblyExpiredSessionError,
  TwoFactorRequiredError,
  mapCaughtError,
  wrapCall,
} from './errors.js';
import { mapClassLife, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable } from './mappers.js';
import { fetchMessage, fetchMessages } from './messaging.js';
import type { EcoleDirecteClient, LoginCredentials, Session, TwoFactorChallenge } from './types.js';

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
 * Turns an authentication result into the session we persist. Note that
 * `token` and `accessToken` are two different secrets: `token` is the
 * short-lived one every data call sends as `X-Token`, `accessToken` is the
 * long-lived per-device credential that mints new ones. Storing one where the
 * other belongs is what made every call fail with "Token invalide !".
 */
function sessionFromAuthResult(
  base: { username: string; deviceUUID: string; cnKey?: string; cvKey?: string },
  result: AuthResult,
): Session {
  const account = (result.accounts as Account[])[0];
  if (!account) throw new PossiblyExpiredSessionError("École Directe n'a renvoyé aucun compte.");
  return {
    username: base.username,
    deviceUUID: base.deviceUUID,
    accountId: String(account.id),
    accountKind: account.typeCompte,
    displayName: `${account.prenom} ${account.nom}`.trim(),
    token: result.token,
    accessToken: account.accessToken,
    cnKey: base.cnKey,
    cvKey: base.cvKey,
    accounts: result.accounts,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * BlocksDirecte's RESTManager starts a rate-limit `setInterval` in its
 * constructor and discards the handle, so nothing can ever clear it: any
 * short-lived process that builds a Client (the smoke test, a one-shot
 * script) would print its results and then hang forever instead of exiting.
 * Capture the timer while the constructor runs — `new Client()` is
 * synchronous, so nothing else can register a timer in between — and unref
 * it. The MCP server is held open by its stdio transport, not by this timer.
 */
function newClientWithoutKeepAlive(credential: Credential): Client {
  const realSetInterval = globalThis.setInterval;
  const captured: NodeJS.Timeout[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
    const timer = realSetInterval(...args);
    captured.push(timer);
    return timer;
  }) as typeof globalThis.setInterval;
  try {
    return new Client(credential);
  } finally {
    globalThis.setInterval = realSetInterval;
    for (const timer of captured) timer.unref?.();
  }
}

/**
 * One Client per session token. Not just an optimisation: each one carries a
 * RESTManager and its interval, so a Client per call would pile them up.
 */
let cachedClient: { token: string; client: Client } | null = null;

/**
 * Builds the BlocksDirecte client straight from the stored session — no
 * network call. The account list is persisted at login precisely so that a
 * fresh process doesn't have to spend a re-login just to learn which account
 * and modules exist; a token that has actually expired surfaces on the first
 * data call and is handled by `withAutoRefresh`.
 */
export function clientFor(session: Session): Client {
  if (cachedClient && cachedClient.token === session.token) return cachedClient.client;
  const accounts = session.accounts as Account[] | undefined;
  if (!session.token || !accounts || accounts.length === 0) {
    throw new AuthenticationRequiredError(
      'Session incomplète ou périmée (jeton ou liste de comptes manquants). Relance `ecoledirecte-mcp login`.',
    );
  }
  const credential: Credential = { token: session.token, accounts, selectedAccounts: 0 };
  const client = newClientWithoutKeepAlive(credential);
  patchBrokenModuleAvailabilityCheck(client);
  cachedClient = { token: session.token, client };
  return client;
}

export function createBlocksDirecteClient(): EcoleDirecteClient {
  return {
    async login({ username, password, deviceUUID }: LoginCredentials): Promise<Session | TwoFactorChallenge> {
      try {
        const result = await edLogin({ username, password, deviceUUID });
        return sessionFromAuthResult({ username, deviceUUID }, result);
      } catch (error) {
        if (error instanceof TwoFactorRequiredError) {
          const question = await edGet2FAQuestion(error.twoFactorToken);
          return { token: error.twoFactorToken, question: question.question, propositions: question.propositions };
        }
        throw mapCaughtError(error);
      }
    },

    async completeTwoFactor(
      challenge: TwoFactorChallenge,
      answer: string,
      { username, password, deviceUUID }: LoginCredentials,
    ): Promise<Session> {
      return wrapCall(async () => {
        const { cn, cv } = await edSend2FAAnswer(answer, challenge.token);
        const result = await edLogin({ username, password, deviceUUID, cnKey: cn, cvKey: cv });
        return sessionFromAuthResult({ username, deviceUUID, cnKey: cn, cvKey: cv }, result);
      });
    },

    async refreshSession(session: Session): Promise<Session> {
      return wrapCall(async () => {
        const result = await edRelogin({
          username: session.username,
          accountKind: session.accountKind,
          accessToken: session.accessToken,
          deviceUUID: session.deviceUUID,
          cnKey: session.cnKey,
          cvKey: session.cvKey,
        });
        return sessionFromAuthResult(session, result);
      });
    },

    async getGrades(session, schoolYear) {
      return wrapCall(async () => {
        const client = clientFor(session);
        const marks = assertPresent(await client.marks.getMark(schoolYear), 'getMark');
        return mapGrades(marks.notes);
      });
    },

    async getHomework(session, fromDate, toDate) {
      return wrapCall(async () => {
        const client = clientFor(session);
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
        const client = clientFor(session);
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
        const client = clientFor(session);
        const courses = assertPresent(
          await client.timetable.getTimetableBetweenDates(new Date(fromDate), new Date(toDate)),
          'getTimetableBetweenDates',
        );
        return mapTimetable(courses);
      });
    },

    async getSchoolLife(session) {
      return wrapCall(async () => {
        const client = clientFor(session);
        return mapSchoolLife(assertPresent(await client.schoollife.getSchoolLife(), 'getSchoolLife'));
      });
    },

    async getClassLife(session) {
      return wrapCall(async () => {
        const client = clientFor(session);
        return mapClassLife(assertPresent(await client.classlife.getClassLife(), 'getClassLife'));
      });
    },

    async getTimeline(session) {
      return wrapCall(async () => {
        const client = clientFor(session);
        return mapTimeline(assertPresent(await client.timeline.getPersonalTimeline(), 'getPersonalTimeline'));
      });
    },

    // Messaging is absent from @blockshub/blocksdirecte, so it goes straight
    // out over HTTP (src/client/messaging.ts) rather than through a client.
    async getMessages(session, folder, limit) {
      return wrapCall(() => fetchMessages(session, folder, limit));
    },

    async getMessage(session, messageId) {
      return wrapCall(() => fetchMessage(session, messageId));
    },

    async downloadDocument(session, fileId, fileType, destinationDir) {
      return wrapCall(async () => {
        const client = clientFor(session);
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
