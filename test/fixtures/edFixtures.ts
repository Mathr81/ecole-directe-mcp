import type {
  RawClassLife,
  RawClassLifeComment,
  RawHomeworkSubject,
  RawMark,
  RawSchoolLife,
  RawSchoolLifeItem,
  RawTimelineItem,
  RawTimetableCourse,
} from '../../src/client/edRaw.js';

export function makeRawMark(overrides: Partial<RawMark> = {}): RawMark {
  return {
    id: 1,
    devoir: 'Contrôle',
    codePeriode: 'A001',
    codeMatiere: 'MATH',
    libelleMatiere: 'Mathématiques',
    codeSousMatiere: '',
    typeDevoir: '',
    date: '2026-01-15',
    coef: '1',
    noteSur: '20',
    valeur: '14,5',
    valeurisee: true,
    nonSignificatif: false,
    moyenneClasse: '12,3',
    minClasse: '5',
    maxClasse: '19',
    ...overrides,
  };
}

export function makeRawHomeworkSubject(overrides: Partial<RawHomeworkSubject> = {}): RawHomeworkSubject {
  return {
    matiere: 'Mathématiques',
    codeMatiere: 'MATH',
    nomProf: 'M. Martin',
    interrogation: false,
    aFaire: {
      idDevoir: 42,
      contenu: '<p>Exercices 1 à 5 page 30</p>',
      donneLe: '2026-01-10',
      effectue: false,
      documents: [],
      contenuDeSeance: { contenu: '', documents: [] },
    },
    ...overrides,
  };
}

export function makeRawTimetableCourse(overrides: Partial<RawTimetableCourse> = {}): RawTimetableCourse {
  return {
    id: 1,
    matiere: 'Mathématiques',
    typeCours: 'COURS',
    start_date: '2026-01-15 08:00',
    end_date: '2026-01-15 09:00',
    prof: 'M. Martin',
    salle: 'B12',
    groupeCode: '',
    isModifie: false,
    isAnnule: false,
    ...overrides,
  };
}

export function makeRawSchoolLife(overrides: Partial<RawSchoolLife> = {}): RawSchoolLife {
  return { absencesRetards: [], dispenses: [], sanctionsEncouragements: [], ...overrides };
}

export function makeRawAttendanceItem(overrides: Partial<RawSchoolLifeItem> = {}): RawSchoolLifeItem {
  return {
    id: 1,
    typeElement: 'Absence',
    date: '2026-01-10',
    libelle: 'Absence non justifiée',
    justifie: false,
    ...overrides,
  };
}

export function makeRawExemptionItem(overrides: Partial<RawSchoolLifeItem> = {}): RawSchoolLifeItem {
  return makeRawAttendanceItem({ typeElement: 'Dispense', ...overrides });
}

export function makeRawConductItem(overrides: Partial<RawSchoolLifeItem> = {}): RawSchoolLifeItem {
  return makeRawAttendanceItem({ typeElement: 'Punition', ...overrides });
}

export function makeRawComment(overrides: Partial<RawClassLifeComment> = {}): RawClassLifeComment {
  return { id: 1, auteur: 'M. Martin', date: '2026-01-09', message: 'Bon travail cette semaine.', ...overrides };
}

export function makeRawClassLife(overrides: Partial<RawClassLife> = {}): RawClassLife {
  return {
    classe: '1ère A',
    contenu: '',
    commentaires: [],
    matieres: { dateMiseAJour: '2026-01-10' },
    ...overrides,
  };
}

export function makeRawPersonalTimelineItem(overrides: Partial<RawTimelineItem> = {}): RawTimelineItem {
  return {
    date: '2026-01-10',
    typeElement: 'Note',
    idElement: 1,
    titre: 'Nouvelle note',
    soustitre: 'Mathématiques',
    ...overrides,
  };
}
