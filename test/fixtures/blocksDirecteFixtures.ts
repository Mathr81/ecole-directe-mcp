import type { Client, TimetableCourse, TimetableCourseType, SchoolLifeAttendanceItem, SchoolLifeAttendanceItemType, SchoolLifeConductItem, SchoolLifeExemptionItem } from '@blockshub/blocksdirecte';

type BDClient = InstanceType<typeof Client>;
export type RawMark = Awaited<ReturnType<BDClient['marks']['getMark']>>['notes'][number];
export type RawHomeworkDate = Awaited<ReturnType<BDClient['homework']['getHomeworksForDate']>>;
export type RawHomeworkSubject = RawHomeworkDate['matieres'][number];
export type RawSchoolLife = Awaited<ReturnType<BDClient['schoollife']['getSchoolLife']>>;
export type RawClassLife = Awaited<ReturnType<BDClient['classlife']['getClassLife']>>;
export type RawComment = RawClassLife['commentaires'][number];
export type RawPersonalTimelineItem = Awaited<ReturnType<BDClient['timeline']['getPersonalTimeline']>>[number];

export function makeRawMark(overrides: Partial<RawMark> = {}): RawMark {
  return {
    id: 1,
    devoir: 'Contrôle',
    codePeriode: 'A001',
    codeMatiere: 'MATH',
    libelleMatiere: 'Mathématiques',
    codeSousMatiere: '',
    typeDevoir: '',
    enLettre: false,
    commentaire: '',
    uncSujet: '',
    uncCorrige: '',
    date: '2026-01-15',
    dateSaisie: '2026-01-16',
    coef: '1',
    noteSur: '20',
    valeur: '14,5',
    valeurisee: true,
    nonSignificatif: false,
    moyenneClasse: '12,3',
    minClasse: '5',
    maxClasse: '19',
    elementsProgramme: [],
    ...overrides,
  };
}

export function makeRawHomeworkSubject(overrides: Partial<RawHomeworkSubject> = {}): RawHomeworkSubject {
  return {
    entityCode: 'C1',
    entityLibelle: '1ère A',
    entityType: 'C' as RawHomeworkSubject['entityType'],
    matiere: 'Mathématiques',
    codeMatiere: 'MATH',
    nomProf: 'M. Martin',
    id: 1,
    interrogation: false,
    blogActif: false,
    nbJourMaxRenduDevoir: 0,
    aFaire: {
      idDevoir: 42,
      contenu: '<p>Exercices 1 à 5 page 30</p>',
      rendreEnLigne: false,
      donneLe: '2026-01-10',
      effectue: false,
      ressource: '',
      documentsRendusDeposes: false,
      ressourceDocuments: [],
      documents: [],
      commentaires: [],
      elementsProg: [],
      liensManuel: [],
      documentsRendus: [],
      tags: [],
      cdtPersonnalises: [],
      contenuDeSeance: { contenu: '', documents: [], commentaires: [] },
    },
    ...overrides,
  };
}

export function makeRawTimetableCourse(overrides: Partial<TimetableCourse> = {}): TimetableCourse {
  return {
    id: 1,
    text: '',
    matiere: 'Mathématiques',
    codeMatiere: 'MATH',
    typeCours: 'COURS' as TimetableCourseType,
    start_date: '2026-01-15 08:00',
    end_date: '2026-01-15 09:00',
    color: '',
    dispensable: false,
    dispense: 0,
    prof: 'M. Martin',
    salle: 'B12',
    classeId: 1,
    classe: '1ère A',
    classeCode: '1A',
    groupeId: 0,
    groupe: '',
    groupeCode: '',
    isFlexible: false,
    icone: '',
    isModifie: false,
    contenuDeSeance: false,
    devoirAFaire: false,
    isAnnule: false,
    evenementId: 0,
    ...overrides,
  };
}

export function makeRawSchoolLife(overrides: Partial<RawSchoolLife> = {}): RawSchoolLife {
  return {
    absencesRetards: [],
    dispenses: [],
    sanctionsEncouragements: [],
    permisPoint: { idPermis: 0, libellePermis: '', dateDebut: '', dateFin: '', totalPoints: 0, evenements: [] },
    parametrage: {
      justificationEnLigne: false,
      absenceCommentaire: false,
      retardCommentaire: false,
      sanctionsVisible: false,
      sanctionParQui: false,
      sanctionCommentaire: false,
      encouragementsVisible: false,
      encouragementParQui: false,
      encouragementCommentaire: false,
      afficherPermisPoint: false,
    },
    ...overrides,
  };
}

export function makeRawAttendanceItem(overrides: Partial<SchoolLifeAttendanceItem> = {}): SchoolLifeAttendanceItem {
  return {
    id: 1,
    idEleve: 1,
    nomEleve: 0,
    typeElement: 'Absence' as SchoolLifeAttendanceItemType,
    date: '2026-01-10',
    displayDate: '10/01/2026',
    libelle: 'Absence non justifiée',
    motif: '',
    justifie: false,
    par: '',
    pointsPermis: 0,
    commentaire: '',
    typeJustification: '',
    justifieEd: false,
    dontNeedJustifiePrim: false,
    aFaire: '',
    dateDeroulement: '',
    matiere: '',
    presence: false,
    jour: 0,
    ...overrides,
  };
}

export function makeRawExemptionItem(overrides: Partial<SchoolLifeExemptionItem> = {}): SchoolLifeExemptionItem {
  return { ...makeRawAttendanceItem(), typeElement: 'Dispense', ...overrides } as SchoolLifeExemptionItem;
}

export function makeRawConductItem(overrides: Partial<SchoolLifeConductItem> = {}): SchoolLifeConductItem {
  return {
    ...makeRawAttendanceItem(),
    typeElement: 'Punition',
    auteur: { id: 1, nom: 'Dupont', prenom: 'Marie', civilite: 'Mme', particule: '', type: 'P' as SchoolLifeConductItem['auteur']['type'] },
    ...overrides,
  } as SchoolLifeConductItem;
}

export function makeRawComment(overrides: Partial<RawComment> = {}): RawComment {
  return {
    id: 1,
    idAuteur: 10,
    profilAuteur: 'P' as RawComment['profilAuteur'],
    auteur: 'M. Martin',
    date: '2026-01-09',
    message: 'Bon travail cette semaine.',
    supprime: false,
    ...overrides,
  };
}

export function makeRawClassLife(overrides: Partial<RawClassLife> = {}): RawClassLife {
  return {
    classe: '1ère A',
    contenu: '',
    idCDT: 1,
    profPrincipal: false,
    commentaires: [],
    fichiers: [],
    matieres: { libelle: '', id: '', idCDT: 1, dateMiseAJour: '2026-01-10', contenu: '', commentaires: [], fichiers: [] },
    ...overrides,
  };
}

export function makeRawPersonalTimelineItem(overrides: Partial<RawPersonalTimelineItem> = {}): RawPersonalTimelineItem {
  return {
    date: '2026-01-10',
    typeElement: 'Note' as RawPersonalTimelineItem['typeElement'],
    idElement: 1,
    titre: 'Nouvelle note',
    soustitre: 'Mathématiques',
    contenu: '',
    ...overrides,
  };
}
