import type { Client, TimetableCourse } from '@blockshub/blocksdirecte';
import type {
  Attachment,
  ClassLifeSummary,
  DocumentCategory,
  Grade,
  GradePeriod,
  HomeworkItem,
  HomeworkReport,
  Lesson,
  SchoolDocument,
  SchoolLifeEntry,
  TimelineEntry,
  TimetableSlot,
} from './types.js';

type BDClient = InstanceType<typeof Client>;
type RawMark = Awaited<ReturnType<BDClient['marks']['getMark']>>['notes'][number];
type RawHomeworkDate = Awaited<ReturnType<BDClient['homework']['getHomeworksForDate']>>;
type RawSchoolLife = Awaited<ReturnType<BDClient['schoollife']['getSchoolLife']>>;
type RawClassLife = Awaited<ReturnType<BDClient['classlife']['getClassLife']>>;
type RawPersonalTimelineItem = Awaited<ReturnType<BDClient['timeline']['getPersonalTimeline']>>[number];

function parseFrenchNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(',', '.').trim());
  return Number.isFinite(value) ? value : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function fromCodePoint(value: number, original: string): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : original;
}

export function stripHtml(html: string): string {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      // Entities are decoded in a single pass so a decoded value can never be
      // decoded again: "&amp;#233;" is the literal text "&#233;", not "é".
      // Numeric entities matter more than the named ones here — École Directe
      // encodes every French accent that way ("chers &#233;l&#232;ves").
      .replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (original, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
          return fromCodePoint(Number.parseInt(entity.slice(2), 16), original);
        }
        if (entity.startsWith('#')) return fromCodePoint(Number.parseInt(entity.slice(1), 10), original);
        return NAMED_ENTITIES[entity.toLowerCase()] ?? original;
      })
      .replace(/\s+/g, ' ')
      .trim()
  );
}

interface RawPeriodDisciplines {
  ensembleMatieres?: { disciplines?: Array<{ codeMatiere?: string; discipline?: string }> };
}

/**
 * Subject code → label, gathered from every period of a grades response. On
 * archived school years most marks come back with an empty `libelleMatiere`,
 * but `codeMatiere` is always set and the periods still list each label.
 */
export function disciplineLabels(periods: RawPeriodDisciplines[] | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const period of periods ?? []) {
    for (const entry of period.ensembleMatieres?.disciplines ?? []) {
      if (entry.codeMatiere && entry.discipline && !labels.has(entry.codeMatiere)) {
        labels.set(entry.codeMatiere, entry.discipline);
      }
    }
  }
  return labels;
}

export function mapGrades(
  notes: RawMark[],
  labels: Map<string, string> = new Map(),
  periodLabels: Map<string, string> = new Map(),
): Grade[] {
  return notes.map((note) => {
    const value = note.valeurisee ? parseFrenchNumber(note.valeur) : null;
    return {
      id: String(note.id),
      subject: note.libelleMatiere || labels.get(note.codeMatiere) || note.codeMatiere,
      subjectCode: note.codeMatiere,
      period: periodLabels.get(note.codePeriode) ?? '',
      periodCode: note.codePeriode,
      type: note.typeDevoir ?? '',
      label: note.devoir,
      value,
      status: value === null ? note.valeur?.trim() || null : null,
      significant: !note.nonSignificatif,
      scale: parseFrenchNumber(note.noteSur) ?? 20,
      date: note.date,
      coefficient: parseFrenchNumber(note.coef) ?? 1,
      classAverage: parseFrenchNumber(note.moyenneClasse),
      classMin: parseFrenchNumber(note.minClasse),
      classMax: parseFrenchNumber(note.maxClasse),
    };
  });
}

interface RawPeriod {
  codePeriode: string;
  periode: string;
  dateDebut?: string;
  dateFin?: string;
  cloture?: boolean;
  annuel?: boolean;
  ensembleMatieres?: {
    moyenneGenerale?: string;
    disciplines?: Array<{
      codeMatiere?: string;
      discipline?: string;
      moyenne?: string;
      coef?: number;
      groupeMatiere?: boolean;
      sousMatiere?: boolean;
    }>;
  };
}

export function mapPeriods(
  periods: RawPeriod[] | undefined,
  { overallPublished = false }: { overallPublished?: boolean } = {},
): GradePeriod[] {
  return (periods ?? []).map((period) => {
    // Until a period is closed, a school that withholds averages still fills
    // these fields — with placeholders ("5" as the overall). Only trust them
    // once the period is closed.
    const closed = period.cloture === true;
    return {
      code: period.codePeriode,
      label: period.periode,
      start: period.dateDebut ?? '',
      end: period.dateFin ?? '',
      closed,
      annual: period.annuel === true,
      subjects: (period.ensembleMatieres?.disciplines ?? [])
        // Group headers ("SCIENCES") and sub-subjects are not subjects of
        // their own: marks are grouped by codeMatiere.
        .filter((entry) => entry.codeMatiere && !entry.groupeMatiere && !entry.sousMatiere)
        .map((entry) => ({
          code: entry.codeMatiere!,
          label: entry.discipline ?? entry.codeMatiere!,
          coefficient: typeof entry.coef === 'number' ? entry.coef : 1,
          officialAverage: closed ? parseFrenchNumber(entry.moyenne) : null,
        })),
      // A school can switch the overall average off (parametrage.moyenneGenerale):
      // the field then holds unrelated values ("1", "2") even once closed.
      officialOverall:
        closed && overallPublished ? parseFrenchNumber(period.ensembleMatieres?.moyenneGenerale) : null,
    };
  });
}

type RawCdtFile = { id: number; libelle: string; taille?: number; type: string };

function mapAttachments(files: RawCdtFile[] | undefined): Attachment[] {
  return (files ?? []).map((file) => ({
    id: String(file.id),
    filename: file.libelle,
    fileType: file.type || 'FICHIER_CDT',
    sizeBytes: file.taille ?? 0,
  }));
}

/**
 * One call per date returns both what is due that day (`aFaire`) and what was
 * done in class that day (`contenuDeSeance`). Most entries are the latter
 * alone — lesson notes, sometimes with the course PDF — so both are kept.
 */
export function mapHomework(perDate: Array<{ date: string; response: RawHomeworkDate }>): HomeworkReport {
  const homework: HomeworkItem[] = [];
  const lessons: Lesson[] = [];
  for (const { date, response } of perDate) {
    for (const subject of response.matieres) {
      const teacher = subject.nomProf?.trim() || null;
      if (subject.aFaire) {
        homework.push({
          id: String(subject.aFaire.idDevoir),
          subject: subject.matiere,
          teacher,
          dueDate: date,
          givenOn: subject.aFaire.donneLe || null,
          description: stripHtml(subject.aFaire.contenu),
          done: subject.aFaire.effectue,
          isTest: subject.interrogation === true,
          lessonContent: stripHtml(subject.aFaire.contenuDeSeance?.contenu ?? '') || null,
          attachments: mapAttachments(subject.aFaire.documents),
        });
      }
      const lesson = subject.contenuDeSeance;
      const content = stripHtml(lesson?.contenu ?? '') || null;
      const attachments = mapAttachments(lesson?.documents);
      if (content || attachments.length > 0) {
        lessons.push({ date, subject: subject.matiere, teacher, content, attachments });
      }
    }
  }
  return { homework, lessons };
}

export function mapTimetable(courses: TimetableCourse[]): TimetableSlot[] {
  return courses
    .map((course) => ({
      id: String(course.id),
      subject: course.matiere,
      teacher: course.prof || null,
      room: course.salle || null,
      group: course.groupeCode || null,
      start: course.start_date,
      end: course.end_date,
      cancelled: course.isAnnule,
      modified: course.isModifie === true,
    }))
    // "AAAA-MM-JJ HH:MM" sorts lexically in chronological order; École Directe
    // returns the slots in no particular order.
    .sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * The library's types declare every section of a response as always present,
 * but École Directe omits whole sections a school doesn't use: a real account
 * returned a school-life payload with no `sanctionsEncouragements` key at all,
 * and `{}` for the entire class-life payload. Both are normal answers, not
 * errors, so the mappers must treat each section as optional rather than
 * trusting the declared type.
 */
function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function mapSchoolLife(schoolLife: RawSchoolLife): SchoolLifeEntry[] {
  const attendance: SchoolLifeEntry[] = asArray(schoolLife.absencesRetards).map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const exemptions: SchoolLifeEntry[] = asArray(schoolLife.dispenses).map((item) => ({
    id: String(item.id),
    type: 'Dispense',
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const conduct: SchoolLifeEntry[] = asArray(schoolLife.sanctionsEncouragements).map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: null,
  }));
  return [...attendance, ...exemptions, ...conduct];
}

export function mapClassLife(classLife: RawClassLife, accountClassName = ''): ClassLifeSummary {
  return {
    className: classLife.classe || accountClassName,
    content: classLife.contenu || null,
    updatedAt: classLife.matieres?.dateMiseAJour || null,
    comments: asArray(classLife.commentaires).map((comment) => ({
      id: String(comment.id),
      author: comment.auteur,
      date: comment.date,
      message: comment.message,
    })),
  };
}

export function mapTimeline(items: RawPersonalTimelineItem[]): TimelineEntry[] {
  return items.map((item) => ({
    id: item.idElement ? String(item.idElement) : null,
    date: item.date,
    type: item.typeElement,
    summary: item.soustitre ? `${item.titre} — ${item.soustitre}` : item.titre,
  }));
}

const DOCUMENT_CATEGORIES: Array<[string, DocumentCategory]> = [
  ['notes', 'bulletin'],
  ['viescolaire', 'vie scolaire'],
  ['administratifs', 'administratif'],
  ['factures', 'facture'],
  ['inscriptions', 'inscription'],
  ['entreprises', 'entreprise'],
];

type RawDocument = { id: number | string; libelle?: string; date?: string; type?: string };

export function mapDocuments(data: Record<string, unknown> | undefined, schoolYear: string | null): SchoolDocument[] {
  const documents: SchoolDocument[] = [];
  for (const [key, category] of DOCUMENT_CATEGORIES) {
    const list = data?.[key];
    if (!Array.isArray(list)) continue;
    for (const item of list as RawDocument[]) {
      documents.push({
        id: String(item.id),
        category,
        label: item.libelle ?? '',
        date: item.date ?? '',
        fileType: item.type ?? '',
        schoolYear,
      });
    }
  }
  return documents;
}
