/**
 * The provider's raw account list, persisted verbatim in the session file.
 * Deliberately opaque here: only the client adapter knows its real shape, so
 * that no provider-specific type leaks into the tools. See `Session.accounts`.
 */
export type ProviderAccounts = readonly unknown[];

export interface Session {
  username: string;
  deviceUUID: string;
  accountId: string;
  accountKind: string;
  displayName: string;
  /**
   * Short-lived session token, sent as the `X-Token` header on every data
   * call. Rotated by every successful login or re-login.
   */
  token: string;
  /**
   * Long-lived per-device credential (École Directe's `access_token`), the
   * only thing that can mint a new `token` without the password. Distinct
   * from `token` — conflating the two is what made every call fail with
   * "Token invalide !".
   */
  accessToken: string;
  cnKey?: string;
  cvKey?: string;
  /**
   * Account payload returned at login, kept so the client can be rebuilt
   * offline on the next process start instead of burning a re-login just to
   * find out which account and modules exist.
   */
  accounts: ProviderAccounts;
  updatedAt: string;
}

export interface TwoFactorChallenge {
  token: string;
  question: string;
  propositions: string[];
}

export interface LoginCredentials {
  username: string;
  password: string;
  deviceUUID: string;
}

export interface Grade {
  id: string;
  subject: string;
  subjectCode: string;
  /** Period label ("1er Semestre"), empty when unknown. */
  period: string;
  periodCode: string;
  /** Kind of assessment as École Directe labels it ("Interrogation Ecrite"…). */
  type: string;
  label: string;
  /** Null when the mark has no numeric value — see `status`. */
  value: number | null;
  /** École Directe's own marker for an ungraded mark ("Abs", "NE", "Disp"…), null for a numeric one. */
  status: string | null;
  /** False for a mark the teacher flagged as not counting towards the average. */
  significant: boolean;
  scale: number;
  date: string;
  coefficient: number;
  classAverage: number | null;
  classMin: number | null;
  classMax: number | null;
}

export interface GradePeriodSubject {
  code: string;
  label: string;
  /** Subject coefficient in the overall average. */
  coefficient: number;
  /** Published by École Directe only once the period is closed. */
  officialAverage: number | null;
}

export interface GradePeriod {
  code: string;
  label: string;
  start: string;
  end: string;
  closed: boolean;
  /** The whole-year period, which spans every mark. */
  annual: boolean;
  subjects: GradePeriodSubject[];
  officialOverall: number | null;
}

export interface SubjectAverage {
  code: string;
  subject: string;
  coefficient: number;
  /** Computed here, on /20: École Directe withholds averages until the period closes. */
  average: number | null;
  /** Same formula over each mark's class average — an estimate, not the official figure. */
  classAverageEstimate: number | null;
  gradeCount: number;
  officialAverage: number | null;
}

export interface PeriodAverages {
  code: string;
  label: string;
  start: string;
  end: string;
  closed: boolean;
  annual: boolean;
  overall: number | null;
  officialOverall: number | null;
  subjects: SubjectAverage[];
}

export interface Attachment {
  id: string;
  filename: string;
  /** Pass as `fileType` to download_document. */
  fileType: string;
  sizeBytes: number;
}

export interface HomeworkItem {
  id: string;
  subject: string;
  teacher: string | null;
  dueDate: string;
  givenOn: string | null;
  description: string;
  done: boolean;
  /** École Directe's `interrogation` flag: a test is scheduled for this date. */
  isTest: boolean;
  /** What was done in the lesson where the homework was set. */
  lessonContent: string | null;
  attachments: Attachment[];
}

/** What was done in class on a date — often with no homework attached. */
export interface Lesson {
  date: string;
  subject: string;
  teacher: string | null;
  content: string | null;
  attachments: Attachment[];
}

export interface HomeworkReport {
  homework: HomeworkItem[];
  lessons: Lesson[];
}

export type DocumentCategory =
  | 'bulletin'
  | 'vie scolaire'
  | 'administratif'
  | 'facture'
  | 'inscription'
  | 'entreprise';

export interface SchoolDocument {
  id: string;
  category: DocumentCategory;
  label: string;
  date: string;
  /** Pass as `fileType` to download_document. */
  fileType: string;
  /** Pass as `schoolYear` to download_document; null for the current year. */
  schoolYear: string | null;
}

export interface TimetableSlot {
  id: string;
  subject: string;
  teacher: string | null;
  room: string | null;
  /**
   * Group code for a group course, null for a whole-class one. Several slots
   * at the same time with the same group are alternatives (one per teacher or
   * room), not courses the student attends simultaneously.
   */
  group: string | null;
  start: string;
  end: string;
  cancelled: boolean;
  /** École Directe's `isModifie`: time, room or teacher changed — it does not say which. */
  modified: boolean;
}

export interface SchoolLifeEntry {
  id: string;
  type: string;
  date: string;
  description: string;
  justified: boolean | null;
}

export interface ClassLifeComment {
  id: string;
  author: string;
  date: string;
  message: string;
}

export interface ClassLifeSummary {
  className: string;
  /** Null when the class has nothing published — École Directe answers `{}`. */
  content: string | null;
  updatedAt: string | null;
  comments: ClassLifeComment[];
}

export interface TimelineEntry {
  /** Null for grouped entries ("Nouvelles évaluations"), which École Directe numbers 0. */
  id: string | null;
  date: string;
  type: string;
  summary: string;
}

export type MessageFolder = 'received' | 'sent' | 'draft' | 'archived';

export interface MessageSummary {
  id: string;
  folder: MessageFolder;
  subject: string;
  /** Sender for received mail, first recipient for sent mail. */
  correspondent: string;
  date: string;
  read: boolean;
  attachmentCount: number;
}

export interface MessageDetail extends MessageSummary {
  /** Body with HTML stripped — the API returns it as an HTML fragment. */
  content: string;
  attachments: Array<{ id: string; filename: string; type: string }>;
}

export interface DownloadResult {
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AuthStatus {
  sessionExists: boolean;
  username: string | null;
  lastRefreshAt: string | null;
  lastErrorCode: number | null;
}

export interface EcoleDirecteClient {
  login(credentials: LoginCredentials): Promise<Session | TwoFactorChallenge>;
  completeTwoFactor(
    challenge: TwoFactorChallenge,
    answer: string,
    credentials: LoginCredentials,
  ): Promise<Session>;
  refreshSession(session: Session): Promise<Session>;
  getGrades(session: Session, schoolYear?: string): Promise<Grade[]>;
  getAverages(session: Session, schoolYear?: string): Promise<PeriodAverages[]>;
  getHomework(session: Session, fromDate: string, toDate: string): Promise<HomeworkReport>;
  markHomeworkDone(session: Session, homeworkId: string, done: boolean): Promise<void>;
  getTimetable(session: Session, fromDate: string, toDate: string): Promise<TimetableSlot[]>;
  getSchoolLife(session: Session): Promise<SchoolLifeEntry[]>;
  getClassLife(session: Session): Promise<ClassLifeSummary>;
  getTimeline(session: Session): Promise<TimelineEntry[]>;
  getMessages(session: Session, folder: MessageFolder, limit: number): Promise<MessageSummary[]>;
  getMessage(session: Session, messageId: string): Promise<MessageDetail>;
  getDocuments(session: Session, schoolYear?: string): Promise<SchoolDocument[]>;
  downloadDocument(
    session: Session,
    fileId: string,
    fileType: string,
    destinationDir: string,
    schoolYear?: string,
  ): Promise<DownloadResult>;
  getAuthStatus(session: Session | null): Promise<AuthStatus>;
}
