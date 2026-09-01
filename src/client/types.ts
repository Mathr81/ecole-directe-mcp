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
  label: string;
  value: number | null;
  scale: number;
  date: string;
  coefficient: number;
  classAverage: number | null;
}

export interface HomeworkItem {
  id: string;
  subject: string;
  dueDate: string;
  description: string;
  done: boolean;
}

export interface TimetableSlot {
  id: string;
  subject: string;
  teacher: string | null;
  room: string | null;
  start: string;
  end: string;
  cancelled: boolean;
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
  content: string;
  updatedAt: string;
  comments: ClassLifeComment[];
}

export interface TimelineEntry {
  id: string;
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
  getHomework(session: Session, fromDate: string, toDate: string): Promise<HomeworkItem[]>;
  markHomeworkDone(session: Session, homeworkId: string, done: boolean): Promise<void>;
  getTimetable(session: Session, fromDate: string, toDate: string): Promise<TimetableSlot[]>;
  getSchoolLife(session: Session): Promise<SchoolLifeEntry[]>;
  getClassLife(session: Session): Promise<ClassLifeSummary>;
  getTimeline(session: Session): Promise<TimelineEntry[]>;
  getMessages(session: Session, folder: MessageFolder, limit: number): Promise<MessageSummary[]>;
  getMessage(session: Session, messageId: string): Promise<MessageDetail>;
  downloadDocument(
    session: Session,
    fileId: string,
    fileType: string,
    destinationDir: string,
  ): Promise<DownloadResult>;
  getAuthStatus(session: Session | null): Promise<AuthStatus>;
}
