/**
 * The École Directe client: authentication (edAuth), data (edData),
 * messaging, documents and downloads, all over direct HTTP, mapped to the
 * DTOs the tools return.
 */
import { edGet2FAQuestion, edLogin, edRelogin, edSend2FAAnswer, type AuthResult } from './edAuth.js';
import {
  PossiblyExpiredSessionError,
  TwoFactorRequiredError,
  mapCaughtError,
  wrapCall,
} from './errors.js';
import { disciplineLabels, mapClassLife, mapGrades, mapPeriods, mapHomework, mapSchoolLife, mapTimeline, mapTimetable } from './mappers.js';
import { fetchDocument } from './download.js';
import { fetchDocuments } from './documents.js';
import { computeAverages } from './averages.js';
import {
  fetchClassLife,
  fetchHomeworkForDate,
  fetchMarks,
  fetchSchoolLife,
  fetchTimeline,
  fetchTimetable,
  fetchUpcomingHomework,
  updateHomework,
} from './edData.js';
import type { RawAccount, RawHomeworkDate } from './edRaw.js';
import { fetchMessage, fetchMessages } from './messaging.js';
import type { EcoleDirecteClient, LoginCredentials, Session, TwoFactorChallenge } from './types.js';

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
  const account = (result.accounts as RawAccount[])[0];
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

async function mapMarks(session: Session, schoolYear: string | undefined) {
  const marks = await fetchMarks(session, schoolYear);
  const labels = disciplineLabels(marks.periodes);
  // Archived years list only a handful of disciplines in their periods,
  // leaving most marks with neither libelleMatiere nor a label for their
  // code. The current year usually knows those codes: one extra call,
  // only when something is actually missing.
  if (schoolYear && marks.notes.some((note) => !note.libelleMatiere && !labels.has(note.codeMatiere))) {
    const current = await fetchMarks(session);
    for (const [code, label] of disciplineLabels(current.periodes)) {
      if (!labels.has(code)) labels.set(code, label);
    }
  }
  const periods = mapPeriods(marks.periodes, { overallPublished: marks.parametrage?.moyenneGenerale === true });
  const periodLabels = new Map(periods.map((period) => [period.code, period.label]));
  return { grades: mapGrades(marks.notes, labels, periodLabels), periods };
}

export function createEcoleDirecteClient(): EcoleDirecteClient {
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
      return wrapCall(async () => mapMarks(session, schoolYear).then(({ grades }) => grades));
    },

    async getAverages(session, schoolYear) {
      return wrapCall(async () => {
        const { grades, periods } = await mapMarks(session, schoolYear);
        return computeAverages(grades, periods);
      });
    },

    async getHomework(session, fromDate, toDate) {
      return wrapCall(async () => {
        const upcoming = await fetchUpcomingHomework(session);
        const dates = Object.keys(upcoming).filter((date) => date >= fromDate && date <= toDate);
        const perDate: Array<{ date: string; response: RawHomeworkDate }> = [];
        for (const date of dates) {
          perDate.push({ date, response: await fetchHomeworkForDate(session, date) });
        }
        return mapHomework(perDate);
      });
    },

    async markHomeworkDone(session, homeworkId, done) {
      return wrapCall(async () => {
        const id = Number(homeworkId);
        await updateHomework(session, done ? [id] : [], done ? [] : [id]);
      });
    },

    async getTimetable(session, fromDate, toDate) {
      return wrapCall(async () => mapTimetable(await fetchTimetable(session, fromDate, toDate)));
    },

    async getSchoolLife(session) {
      return wrapCall(async () => mapSchoolLife(await fetchSchoolLife(session)));
    },

    async getClassLife(session) {
      return wrapCall(async () => {
        const account = (session.accounts as RawAccount[])[0];
        return mapClassLife(await fetchClassLife(session), account?.profile?.classe?.libelle ?? '');
      });
    },

    async getTimeline(session) {
      return wrapCall(async () => mapTimeline(await fetchTimeline(session)));
    },

    async getMessages(session, folder, limit) {
      return wrapCall(() => fetchMessages(session, folder, limit));
    },

    async getMessage(session, messageId) {
      return wrapCall(() => fetchMessage(session, messageId));
    },

    async getDocuments(session, schoolYear) {
      return wrapCall(() => fetchDocuments(session, schoolYear));
    },

    async downloadDocument(session, fileId, fileType, destinationDir, schoolYear) {
      return wrapCall(() => fetchDocument(session, fileId, fileType, destinationDir, schoolYear));
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
