/**
 * Shapes of École Directe's raw responses, limited to the fields this server
 * reads. Written from live responses; fields École Directe is known to omit
 * are optional, so the mappers have to handle their absence.
 */

export interface RawAccount {
  id: number;
  typeCompte: string;
  prenom: string;
  nom: string;
  accessToken: string;
  profile?: { classe?: { id: number; libelle: string } };
}

export interface RawMark {
  id: number;
  devoir: string;
  codePeriode: string;
  codeMatiere: string;
  libelleMatiere: string;
  codeSousMatiere?: string;
  typeDevoir?: string;
  date: string;
  coef: string;
  noteSur: string;
  valeur: string;
  valeurisee: boolean;
  nonSignificatif: boolean;
  moyenneClasse?: string;
  minClasse?: string;
  maxClasse?: string;
}

export interface RawDiscipline {
  codeMatiere?: string;
  discipline?: string;
  moyenne?: string;
  coef?: number;
  groupeMatiere?: boolean;
  sousMatiere?: boolean;
}

export interface RawPeriod {
  codePeriode: string;
  periode: string;
  dateDebut?: string;
  dateFin?: string;
  cloture?: boolean;
  annuel?: boolean;
  ensembleMatieres?: { moyenneGenerale?: string; disciplines?: RawDiscipline[] };
}

export interface RawMarks {
  notes: RawMark[];
  periodes?: RawPeriod[];
  /** `moyenneGenerale: false` when the school does not publish an overall average. */
  parametrage?: { moyenneGenerale?: boolean };
}

export interface RawCdtFile {
  id: number;
  libelle: string;
  taille?: number;
  type: string;
}

export interface RawLessonContent {
  /** Base64 in the raw response; decoded by edData. */
  contenu?: string;
  documents?: RawCdtFile[];
}

export interface RawHomework {
  idDevoir: number;
  /** Base64 in the raw response; decoded by edData. */
  contenu: string;
  donneLe?: string;
  effectue: boolean;
  documents?: RawCdtFile[];
  contenuDeSeance?: RawLessonContent;
}

export interface RawHomeworkSubject {
  matiere: string;
  codeMatiere?: string;
  nomProf?: string;
  interrogation?: boolean;
  aFaire?: RawHomework;
  contenuDeSeance?: RawLessonContent;
}

export interface RawHomeworkDate {
  date: string;
  matieres: RawHomeworkSubject[];
}

/** Dates (AAAA-MM-JJ) the cahier de textes has entries for. */
export type RawHomeworkUpcoming = Record<string, unknown>;

export interface RawTimetableCourse {
  id: number;
  matiere: string;
  typeCours?: string;
  prof?: string;
  salle?: string;
  groupeCode?: string;
  start_date: string;
  end_date: string;
  isAnnule?: boolean;
  isModifie?: boolean;
}

export interface RawSchoolLifeItem {
  id: number;
  typeElement: string;
  date: string;
  libelle: string;
  justifie?: boolean;
}

export interface RawSchoolLife {
  absencesRetards?: RawSchoolLifeItem[];
  dispenses?: RawSchoolLifeItem[];
  sanctionsEncouragements?: RawSchoolLifeItem[];
}

export interface RawClassLifeComment {
  id: number;
  auteur: string;
  date: string;
  message: string;
}

export interface RawClassLife {
  classe?: string;
  /** Base64 in the raw response; decoded by edData. */
  contenu?: string;
  matieres?: { dateMiseAJour?: string };
  commentaires?: RawClassLifeComment[];
}

export interface RawTimelineItem {
  date: string;
  typeElement: string;
  idElement: number;
  titre: string;
  soustitre?: string;
}
