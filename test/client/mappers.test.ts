import { describe, expect, it } from 'vitest';
import { disciplineLabels, mapClassLife, mapDocuments, mapPeriods, mapGrades, mapHomework, mapSchoolLife, mapTimeline, mapTimetable, stripHtml } from '../../src/client/mappers.js';
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

  it("keeps École Directe's own marker for an ungraded mark, such as Abs", () => {
    const [graded, absent] = mapGrades([
      makeRawMark({ id: 1, valeur: '14,5' }),
      makeRawMark({ id: 2, valeur: 'Abs ', valeurisee: false }),
    ]);

    expect(graded.status).toBeNull();
    expect(absent).toMatchObject({ value: null, status: 'Abs' });
  });

  it('keeps the value of a non-significant mark and flags it instead of dropping it', () => {
    const [mark] = mapGrades([makeRawMark({ valeur: '8', nonSignificatif: true })]);

    expect(mark).toMatchObject({ value: 8, significant: false });
  });

  it('falls back to the period discipline label when libelleMatiere is empty', () => {
    // Observed on an archived school year: most marks come back with an empty
    // libelleMatiere, but codeMatiere is always set and the periods list the
    // label for each code.
    const [labelled, fromPeriods, unknown] = mapGrades(
      [
        makeRawMark({ id: 1, codeMatiere: 'G-SCI', libelleMatiere: 'ENSEIGN.SCIENTIFIQUE' }),
        makeRawMark({ id: 2, codeMatiere: 'PH-CH', libelleMatiere: '' }),
        makeRawMark({ id: 3, codeMatiere: 'ESP2', libelleMatiere: '' }),
      ],
      new Map([['PH-CH', 'PHYSIQUE-CHIMIE']]),
    );

    expect(labelled.subject).toBe('ENSEIGN.SCIENTIFIQUE');
    expect(fromPeriods.subject).toBe('PHYSIQUE-CHIMIE');
    expect(unknown.subject).toBe('ESP2');
  });
});

describe('mapGrades period and class fields', () => {
  it('carries the subject code, the period and the class spread', () => {
    const [mark] = mapGrades(
      [makeRawMark({ codeMatiere: 'PH-CH', codePeriode: 'A001', typeDevoir: 'Interrogation Ecrite', minClasse: '8.00', maxClasse: '10,00' })],
      new Map(),
      new Map([['A001', '1er Semestre']]),
    );

    expect(mark).toMatchObject({
      subjectCode: 'PH-CH',
      periodCode: 'A001',
      period: '1er Semestre',
      type: 'Interrogation Ecrite',
      classMin: 8,
      classMax: 10,
    });
  });
});

describe('mapPeriods', () => {
  const discipline = (overrides: Record<string, unknown> = {}) => ({
    codeMatiere: 'MATHS',
    discipline: 'MATHEMATIQUES',
    moyenne: '',
    coef: 3,
    groupeMatiere: false,
    sousMatiere: false,
    ...overrides,
  });

  it('lists each period with its subjects and their coefficients', () => {
    const [period] = mapPeriods([
      {
        codePeriode: 'A001',
        periode: '1er Semestre',
        dateDebut: '2026-09-01',
        dateFin: '2027-01-15',
        cloture: false,
        annuel: false,
        ensembleMatieres: {
          moyenneGenerale: '5',
          disciplines: [
            discipline(),
            discipline({ codeMatiere: 'SCI', discipline: 'SCIENCES', groupeMatiere: true }),
            discipline({ codeMatiere: 'MATHS', discipline: 'ALGEBRE', sousMatiere: true }),
          ],
        },
      },
    ]);

    expect(period).toEqual({
      code: 'A001',
      label: '1er Semestre',
      start: '2026-09-01',
      end: '2027-01-15',
      closed: false,
      annual: false,
      // Group headers and sub-subjects are not subjects of their own.
      subjects: [{ code: 'MATHS', label: 'MATHEMATIQUES', coefficient: 3, officialAverage: null }],
      // Not closed: École Directe fills these with placeholder values ("5").
      officialOverall: null,
    });
  });

  it('reads the official averages only once the period is closed', () => {
    const [period] = mapPeriods(
      [
      {
        codePeriode: 'A001',
        periode: '1er Semestre',
        cloture: true,
        annuel: false,
        ensembleMatieres: { moyenneGenerale: '13,9', disciplines: [discipline({ moyenne: '13,8' })] },
      },
      ],
      { overallPublished: true },
    );

    expect(period.officialOverall).toBe(13.9);
    expect(period.subjects[0].officialAverage).toBe(13.8);
  });

  it('ignores the overall figure when the school does not publish one', () => {
    // Observed on closed periods of a school with parametrage.moyenneGenerale
    // false: the field held "1" and "2" — nothing like the real average.
    const [period] = mapPeriods(
      [{ codePeriode: 'A001', periode: 'S1', cloture: true, ensembleMatieres: { moyenneGenerale: '1', disciplines: [] } }],
      { overallPublished: false },
    );

    expect(period.officialOverall).toBeNull();
  });
});

describe('mapDocuments', () => {
  it('flattens the categories, keeping the fileType and school year needed to download each one', () => {
    const documents = mapDocuments(
      {
        notes: [{ id: 10339, libelle: 'Bulletin 2ème Semestre', date: '2026-06-04', type: 'Note' }],
        administratifs: [{ id: 2056, libelle: 'Certificat de Scolarité', date: '2025-09-02', type: '' }],
        factures: [],
        listesPiecesAVerser: { listesPieces: [] },
      },
      '2025-2026',
    );

    expect(documents).toEqual([
      { id: '10339', category: 'bulletin', label: 'Bulletin 2ème Semestre', date: '2026-06-04', fileType: 'Note', schoolYear: '2025-2026' },
      { id: '2056', category: 'administratif', label: 'Certificat de Scolarité', date: '2025-09-02', fileType: '', schoolYear: '2025-2026' },
    ]);
  });

  it('tolerates a missing payload', () => {
    expect(mapDocuments(undefined, null)).toEqual([]);
  });
});

describe('disciplineLabels', () => {
  it('maps each subject code to its label across periods', () => {
    const labels = disciplineLabels([
      { ensembleMatieres: { disciplines: [{ codeMatiere: 'PH-CH', discipline: 'PHYSIQUE-CHIMIE' }] } },
      { ensembleMatieres: { disciplines: [{ codeMatiere: 'MATHS', discipline: 'MATHEMATIQUES' }] } },
      {},
    ]);

    expect(labels.get('PH-CH')).toBe('PHYSIQUE-CHIMIE');
    expect(labels.get('MATHS')).toBe('MATHEMATIQUES');
  });
});

describe('stripHtml', () => {
  it('removes tags, decodes common entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Exercices 1 &amp; 5   page&nbsp;30</p>')).toBe('Exercices 1 & 5 page 30');
  });

  it('decodes numeric entities, which is how École Directe encodes accents', () => {
    // Real message bodies come back with "Chers parents, chers &#233;l&#232;ves"
    // — leaving those raw makes the promised clean text unreadable in French.
    expect(stripHtml('<p>Chers &#233;l&#232;ves, &#224; demain</p>')).toBe('Chers élèves, à demain');
    expect(stripHtml('caf&#xE9; ferm&#XE9;')).toBe('café fermé');
  });

  it('does not decode an entity twice', () => {
    // "&amp;#233;" means the literal text "&#233;", not "é".
    expect(stripHtml('&amp;#233;')).toBe('&#233;');
  });

  it('leaves an unknown entity as written', () => {
    expect(stripHtml('100 &euros; &#999999999999;')).toBe('100 &euros; &#999999999999;');
  });
});

describe('mapHomework', () => {
  it('flattens per-date subjects that have homework, using the requested date (not the response date), and stripping HTML', () => {
    const { homework } = mapHomework([
      {
        date: '2026-01-12',
        response: { date: '2099-12-31', matieres: [makeRawHomeworkSubject(), makeRawHomeworkSubject({ aFaire: undefined })] },
      },
    ]);

    expect(homework).toHaveLength(1);
    expect(homework[0]).toMatchObject({
      id: '42',
      subject: 'Mathématiques',
      teacher: 'M. Martin',
      dueDate: '2026-01-12',
      givenOn: '2026-01-10',
      done: false,
      isTest: false,
      description: 'Exercices 1 à 5 page 30',
      lessonContent: null,
      attachments: [],
    });
  });

  it('flags a test, and lists attachments with the fileType download_document needs', () => {
    const subject = makeRawHomeworkSubject({ interrogation: true });
    subject.aFaire!.documents = [
      { id: 593, libelle: 'Cours 21 09.pdf', taille: 49312, type: 'FICHIER_CDT', signatureDemandee: false, etatSignatures: [], signature: {} },
    ];
    subject.aFaire!.contenuDeSeance = { contenu: '<p>Loi binomiale</p>', documents: [], commentaires: [] };

    const { homework } = mapHomework([{ date: '2026-09-22', response: { date: '2026-09-22', matieres: [subject] } }]);

    expect(homework[0]).toMatchObject({
      isTest: true,
      lessonContent: 'Loi binomiale',
      attachments: [{ id: '593', filename: 'Cours 21 09.pdf', fileType: 'FICHIER_CDT', sizeBytes: 49312 }],
    });
  });

  it('keeps what was done in class on each date, including lessons that set no homework', () => {
    // Observed: most entries are lessons with content and sometimes a course
    // PDF, but no aFaire — they used to be dropped.
    const lesson = makeRawHomeworkSubject({
      aFaire: undefined,
      matiere: 'MATHS EXPERTES',
      nomProf: 'Mme A.',
      contenuDeSeance: {
        idDevoir: 7,
        contenu: '<p>Congruences</p>',
        documents: [
          { id: 594, libelle: 'Cours.pdf', taille: 10, type: 'FICHIER_CDT', signatureDemandee: false, etatSignatures: [], signature: {} },
        ],
        commentaires: [],
        elementsProg: [],
        liensManuel: [],
      },
    });
    const empty = makeRawHomeworkSubject({ aFaire: undefined });

    const { homework, lessons } = mapHomework([{ date: '2026-09-21', response: { date: '2026-09-21', matieres: [lesson, empty] } }]);

    expect(homework).toEqual([]);
    expect(lessons).toEqual([
      {
        date: '2026-09-21',
        subject: 'MATHS EXPERTES',
        teacher: 'Mme A.',
        content: 'Congruences',
        attachments: [{ id: '594', filename: 'Cours.pdf', fileType: 'FICHIER_CDT', sizeBytes: 10 }],
      },
    ]);
  });
});

describe('mapTimetable', () => {
  it('maps course slots, treating empty prof/salle as null', () => {
    const [slot] = mapTimetable([makeRawTimetableCourse({ prof: '', salle: 'B12', isAnnule: true })]);
    expect(slot).toMatchObject({ teacher: null, room: 'B12', cancelled: true, modified: false });
  });

  it('flags a modified course', () => {
    const [slot] = mapTimetable([makeRawTimetableCourse({ isModifie: true })]);

    expect(slot.modified).toBe(true);
  });

  it('sorts slots chronologically, since École Directe returns them in no particular order', () => {
    const slots = mapTimetable([
      makeRawTimetableCourse({ id: 1, start_date: '2026-09-28 11:05' }),
      makeRawTimetableCourse({ id: 2, start_date: '2026-09-28 13:45' }),
      makeRawTimetableCourse({ id: 3, start_date: '2026-09-28 07:55' }),
    ]);

    expect(slots.map((s) => s.id)).toEqual(['3', '1', '2']);
  });

  it('exposes the group, so parallel slots of one group read as alternatives', () => {
    const [slot, whole] = mapTimetable([
      makeRawTimetableCourse({ id: 1, groupeCode: 'TG3ACCPE', classeCode: '' }),
      makeRawTimetableCourse({ id: 2, start_date: '2099-01-01 08:00', groupeCode: '', classeCode: 'TG3' }),
    ]);

    expect(slot.group).toBe('TG3ACCPE');
    expect(whole.group).toBeNull();
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

  it('tolerates a section École Directe omits entirely', () => {
    // Observed against a real account: the payload came back with
    // absencesRetards, dispenses, permisPoint and parametrage — and no
    // sanctionsEncouragements key at all. The library's types promise it is
    // always there.
    const raw = makeRawSchoolLife({ absencesRetards: [makeRawAttendanceItem({ id: 1 })], dispenses: [] });
    delete (raw as { sanctionsEncouragements?: unknown }).sanctionsEncouragements;

    expect(mapSchoolLife(raw).map((e) => e.id)).toEqual(['1']);
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

  it('returns an empty summary when École Directe has nothing for the class', () => {
    // Observed against a real account: the endpoint answers `{}` — not an
    // error, just no class-life content.
    const summary = mapClassLife({} as Parameters<typeof mapClassLife>[0], 'Terminale G3');

    // Nulls, not empty strings, so "nothing published" cannot pass for a
    // parsing failure; the class name comes from the account instead.
    expect(summary).toEqual({ className: 'Terminale G3', content: null, updatedAt: null, comments: [] });
  });
});

describe('mapTimeline', () => {
  it('joins titre and soustitre into a summary', () => {
    const [entry] = mapTimeline([makeRawPersonalTimelineItem({ titre: 'Nouvelle note', soustitre: 'Maths' })]);
    expect(entry.summary).toBe('Nouvelle note — Maths');
  });

  it('reports no id for grouped entries, which École Directe numbers 0', () => {
    const [grouped, single] = mapTimeline([
      makeRawPersonalTimelineItem({ idElement: 0, titre: 'Nouvelles évaluations' }),
      makeRawPersonalTimelineItem({ idElement: 77 }),
    ]);

    expect(grouped.id).toBeNull();
    expect(single.id).toBe('77');
  });
});
