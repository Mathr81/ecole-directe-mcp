export interface Session {
  username: string;
  deviceUUID: string;
  accountId: string;
  accountKind: string;
  displayName: string;
  accessToken: string;
  cnKey?: string;
  cvKey?: string;
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
  downloadDocument(
    session: Session,
    fileId: string,
    fileType: string,
    destinationDir: string,
  ): Promise<DownloadResult>;
  getAuthStatus(session: Session | null): Promise<AuthStatus>;
}
