import { describe, expect, it } from 'vitest';
import { mapClassLife, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable, stripHtml } from '../../src/client/mappers.js';
import {
  makeRawAttendanceItem,
  makeRawClassLife,
  makeRawComment,
  makeRawConductItem,
  makeRawExemptionItem,
  makeRawHomeworkSubject,
  makeRawMark,
  makeRawPersonalTimelineItem,
  makeRawSchoolLife,
  makeRawTimetableCourse,
} from '../fixtures/blocksDirecteFixtures.js';

describe('mapGrades', () => {
  it('parses French decimal notation and flags non-numeric grades as null', () => {
    const [graded, absent] = mapGrades([
      makeRawMark({ id: 1, valeur: '14,5', valeurisee: true, nonSignificatif: false }),
      makeRawMark({ id: 2, valeur: 'Absent', valeurisee: false }),
    ]);

    expect(graded).toMatchObject({ id: '1', value: 14.5, scale: 20, coefficient: 1, classAverage: 12.3 });
    expect(absent.value).toBeNull();
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes common entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Exercices 1 &amp; 5   page&nbsp;30</p>')).toBe('Exercices 1 & 5 page 30');
  });
});

describe('mapHomework', () => {
  it('flattens per-date subjects that have homework, using the requested date (not the response date), skipping subjects without homework, and stripping HTML', () => {
    const items = mapHomework([
      {
        date: '2026-01-12',
        response: { date: '2099-12-31', matieres: [makeRawHomeworkSubject(), makeRawHomeworkSubject({ aFaire: undefined })] },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '42',
      subject: 'Mathématiques',
      dueDate: '2026-01-12',
      done: false,
      description: 'Exercices 1 à 5 page 30',
    });
  });
});

describe('mapTimetable', () => {
  it('maps course slots, treating empty prof/salle as null', () => {
    const [slot] = mapTimetable([makeRawTimetableCourse({ prof: '', salle: 'B12', isAnnule: true })]);
    expect(slot).toMatchObject({ teacher: null, room: 'B12', cancelled: true });
  });
});

describe('mapSchoolLife', () => {
  it('combines attendance, exemptions and conduct into one flat list', () => {
    const entries = mapSchoolLife(
      makeRawSchoolLife({
        absencesRetards: [makeRawAttendanceItem({ id: 1 })],
        dispenses: [makeRawExemptionItem({ id: 2 })],
        sanctionsEncouragements: [makeRawConductItem({ id: 3 })],
      }),
    );
    expect(entries.map((e) => e.id)).toEqual(['1', '2', '3']);
  });
});

describe('mapClassLife', () => {
  it('maps to a single summary object, correctly reading auteur as a plain string (unlike SchoolLifeConductItem.auteur, which is an object)', () => {
    const summary = mapClassLife(
      makeRawClassLife({ classe: '1ère A', contenu: 'RAS', commentaires: [makeRawComment()] }),
    );

    expect(summary).toMatchObject({ className: '1ère A', content: 'RAS', updatedAt: '2026-01-10' });
    expect(summary.comments).toEqual([
      { id: '1', author: 'M. Martin', date: '2026-01-09', message: 'Bon travail cette semaine.' },
    ]);
  });
});

describe('mapTimeline', () => {
  it('joins titre and soustitre into a summary', () => {
    const [entry] = mapTimeline([makeRawPersonalTimelineItem({ titre: 'Nouvelle note', soustitre: 'Maths' })]);
    expect(entry.summary).toBe('Nouvelle note — Maths');
  });
});
