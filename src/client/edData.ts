/**
 * École Directe's data endpoints, over direct HTTP.
 *
 * These used to go through @blockshub/blocksdirecte. Calling them directly
 * removes three problems the library caused:
 *
 *  - it discarded École Directe's numeric code, so an expired token could
 *    only be guessed from an empty answer; `post` sees the code, and 520/525
 *    become a TokenExpiredError withAutoRefresh acts on;
 *  - it base64-decoded every string that looked like base64, which mangles
 *    short codes ("ESP2"); only the fields known to be encoded are decoded;
 *  - it started an interval timer per client that nothing could clear.
 *
 * Paths and payloads are the ones the library sent, checked against the live
 * API. The student's account id and kind come from the stored session.
 */
import { decodeMaybeBase64 } from './base64.js';
import { post } from './edHttp.js';
import { AuthenticationRequiredError, PossiblyExpiredSessionError } from './errors.js';
import type {
  RawAccount,
  RawClassLife,
  RawHomeworkDate,
  RawHomeworkUpcoming,
  RawLessonContent,
  RawMarks,
  RawSchoolLife,
  RawTimelineItem,
  RawTimetableCourse,
} from './edRaw.js';
import type { Session } from './types.js';

/** "Aucune donnée à afficher": an empty section, not a failure. */
const EMPTY = { emptyCodes: [210] };

const KIND_PATHS: Record<string, string> = {
  E: 'eleves',
  '1': 'familles',
  '2': 'familles',
  A: 'personnels',
  P: 'enseignants',
};

function kindPath(session: Session): string {
  return KIND_PATHS[session.accountKind] ?? 'eleves';
}

/** The cahier de textes wants the same segment capitalised ("Eleves"). */
function kindPathCapitalised(session: Session): string {
  const path = kindPath(session);
  return path.charAt(0).toUpperCase() + path.slice(1);
}

function present<T>(value: unknown, context: string): T {
  if (value === null || value === undefined) {
    throw new PossiblyExpiredSessionError(
      `École Directe (${context}) a répondu sans données — session probablement expirée.`,
    );
  }
  return value as T;
}

function decodeLesson(lesson: RawLessonContent | undefined): void {
  if (lesson?.contenu) lesson.contenu = decodeMaybeBase64(lesson.contenu);
}

export async function fetchMarks(session: Session, schoolYear?: string): Promise<RawMarks> {
  const data = await post(session, `/v3/${kindPath(session)}/${session.accountId}/notes.awp?verbe=get`, {
    anneeScolaire: schoolYear ?? '',
  });
  const marks = present<RawMarks>(data, 'notes');
  return { ...marks, notes: marks.notes ?? [] };
}

export async function fetchUpcomingHomework(session: Session): Promise<RawHomeworkUpcoming> {
  const data = await post(
    session,
    `/v3/${kindPathCapitalised(session)}/${session.accountId}/cahierdetexte.awp?verbe=get`,
    {},
    EMPTY,
  );
  return (data as RawHomeworkUpcoming | null) ?? {};
}

export async function fetchHomeworkForDate(session: Session, date: string): Promise<RawHomeworkDate> {
  const data = await post(
    session,
    `/v3/${kindPathCapitalised(session)}/${session.accountId}/cahierdetexte/${date}.awp?verbe=get`,
    {},
  );
  const day = present<RawHomeworkDate>(data, 'cahier de textes');
  const matieres = day.matieres ?? [];
  for (const subject of matieres) {
    if (subject.aFaire) {
      subject.aFaire.contenu = decodeMaybeBase64(subject.aFaire.contenu);
      decodeLesson(subject.aFaire.contenuDeSeance);
    }
    decodeLesson(subject.contenuDeSeance);
  }
  return { ...day, matieres };
}

export async function updateHomework(session: Session, done: number[], undone: number[]): Promise<void> {
  await post(session, `/v3/${kindPathCapitalised(session)}/${session.accountId}/cahierdetexte.awp?verbe=put`, {
    idDevoirsEffectues: done,
    idDevoirsNonEffectues: undone,
  });
}

export async function fetchTimetable(session: Session, fromDate: string, toDate: string): Promise<RawTimetableCourse[]> {
  // The raw account kind ("E"), unlike every other endpoint.
  const data = await post(
    session,
    `/v3/${session.accountKind}/${session.accountId}/emploidutemps.awp?verbe=get`,
    { dateDebut: fromDate, dateFin: toDate, avecTrous: false },
    EMPTY,
  );
  return (data as RawTimetableCourse[] | null) ?? [];
}

export async function fetchSchoolLife(session: Session): Promise<RawSchoolLife> {
  const data = await post(session, `/v3/${kindPath(session)}/${session.accountId}/viescolaire.awp?verbe=get`, {}, EMPTY);
  return (data as RawSchoolLife | null) ?? {};
}

export async function fetchClassLife(session: Session): Promise<RawClassLife> {
  const classId = (session.accounts as RawAccount[])[0]?.profile?.classe?.id;
  if (!classId) {
    throw new AuthenticationRequiredError(
      "La session ne contient pas la classe de l'élève. Relance `ecoledirecte-mcp login`.",
    );
  }
  const data = await post(session, `/v3/Classes/${classId}/viedelaclasse.awp?verbe=get`, {}, EMPTY);
  const classLife = (data as RawClassLife | null) ?? {};
  if (classLife.contenu) classLife.contenu = decodeMaybeBase64(classLife.contenu);
  return classLife;
}

export async function fetchTimeline(session: Session): Promise<RawTimelineItem[]> {
  const data = await post(session, `/v3/${kindPath(session)}/${session.accountId}/timeline.awp?verbe=get`, {}, EMPTY);
  return (data as RawTimelineItem[] | null) ?? [];
}
