import type { Client, TimetableCourse } from '@blockshub/blocksdirecte';
import type { ClassLifeSummary, Grade, HomeworkItem, SchoolLifeEntry, TimelineEntry, TimetableSlot } from './types.js';

type BDClient = InstanceType<typeof Client>;
type RawMark = Awaited<ReturnType<BDClient['marks']['getMark']>>['notes'][number];
type RawHomeworkDate = Awaited<ReturnType<BDClient['homework']['getHomeworksForDate']>>;
type RawSchoolLife = Awaited<ReturnType<BDClient['schoollife']['getSchoolLife']>>;
type RawClassLife = Awaited<ReturnType<BDClient['classlife']['getClassLife']>>;
type RawPersonalTimelineItem = Awaited<ReturnType<BDClient['timeline']['getPersonalTimeline']>>[number];

function parseFrenchNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(',', '.').trim());
  return Number.isFinite(value) ? value : null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapGrades(notes: RawMark[]): Grade[] {
  return notes.map((note) => ({
    id: String(note.id),
    subject: note.libelleMatiere,
    label: note.devoir,
    value: note.valeurisee && !note.nonSignificatif ? parseFrenchNumber(note.valeur) : null,
    scale: parseFrenchNumber(note.noteSur) ?? 20,
    date: note.date,
    coefficient: parseFrenchNumber(note.coef) ?? 1,
    classAverage: parseFrenchNumber(note.moyenneClasse),
  }));
}

export function mapHomework(perDate: Array<{ date: string; response: RawHomeworkDate }>): HomeworkItem[] {
  const items: HomeworkItem[] = [];
  for (const { date, response } of perDate) {
    for (const subject of response.matieres) {
      if (!subject.aFaire) continue;
      items.push({
        id: String(subject.aFaire.idDevoir),
        subject: subject.matiere,
        dueDate: date,
        description: stripHtml(subject.aFaire.contenu),
        done: subject.aFaire.effectue,
      });
    }
  }
  return items;
}

export function mapTimetable(courses: TimetableCourse[]): TimetableSlot[] {
  return courses.map((course) => ({
    id: String(course.id),
    subject: course.matiere,
    teacher: course.prof || null,
    room: course.salle || null,
    start: course.start_date,
    end: course.end_date,
    cancelled: course.isAnnule,
  }));
}

export function mapSchoolLife(schoolLife: RawSchoolLife): SchoolLifeEntry[] {
  const attendance: SchoolLifeEntry[] = schoolLife.absencesRetards.map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const exemptions: SchoolLifeEntry[] = schoolLife.dispenses.map((item) => ({
    id: String(item.id),
    type: 'Dispense',
    date: item.date,
    description: item.libelle,
    justified: item.justifie,
  }));
  const conduct: SchoolLifeEntry[] = schoolLife.sanctionsEncouragements.map((item) => ({
    id: String(item.id),
    type: item.typeElement,
    date: item.date,
    description: item.libelle,
    justified: null,
  }));
  return [...attendance, ...exemptions, ...conduct];
}

export function mapClassLife(classLife: RawClassLife): ClassLifeSummary {
  return {
    className: classLife.classe,
    content: classLife.contenu,
    updatedAt: classLife.matieres?.dateMiseAJour ?? '',
    comments: classLife.commentaires.map((comment) => ({
      id: String(comment.id),
      author: comment.auteur,
      date: comment.date,
      message: comment.message,
    })),
  };
}

export function mapTimeline(items: RawPersonalTimelineItem[]): TimelineEntry[] {
  return items.map((item) => ({
    id: String(item.idElement),
    date: item.date,
    type: item.typeElement,
    summary: item.soustitre ? `${item.titre} — ${item.soustitre}` : item.titre,
  }));
}
