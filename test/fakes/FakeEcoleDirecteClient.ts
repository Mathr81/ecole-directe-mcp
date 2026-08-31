import type {
  AuthStatus,
  ClassLifeSummary,
  DownloadResult,
  EcoleDirecteClient,
  Grade,
  HomeworkItem,
  LoginCredentials,
  SchoolLifeEntry,
  Session,
  TimelineEntry,
  TimetableSlot,
  TwoFactorChallenge,
} from '../../src/client/types.js';

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    username: 'jdupont',
    deviceUUID: 'device-uuid-1',
    accountId: '12345',
    accountKind: 'E',
    displayName: 'Jean Dupont',
    accessToken: 'fake-access-token',
    cnKey: undefined,
    cvKey: undefined,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

type MethodName = keyof EcoleDirecteClient;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FakeEcoleDirecteClient implements EcoleDirecteClient {
  session: Session = makeSession();
  twoFactorChallenge: TwoFactorChallenge | null = null;
  refreshedSession: Session | null = null;
  grades: Grade[] = [];
  homework: HomeworkItem[] = [];
  timetable: TimetableSlot[] = [];
  schoolLife: SchoolLifeEntry[] = [];
  classLife: ClassLifeSummary = { className: '', content: '', updatedAt: '', comments: [] };
  timeline: TimelineEntry[] = [];
  downloadResult: DownloadResult = { path: '', filename: '', mimeType: '', sizeBytes: 0 };
  callDelayMs = 0;

  callCounts: Partial<Record<MethodName, number>> = {};
  globalInFlight = 0;
  globalMaxConcurrent = 0;
  private failQueues: Partial<Record<MethodName, Error[]>> = {};

  queueFailure(method: MethodName, error: Error): void {
    (this.failQueues[method] ??= []).push(error);
  }

  private async record<T>(method: MethodName, fn: () => T | Promise<T>): Promise<T> {
    this.callCounts[method] = (this.callCounts[method] ?? 0) + 1;
    this.globalInFlight += 1;
    this.globalMaxConcurrent = Math.max(this.globalMaxConcurrent, this.globalInFlight);
    try {
      if (this.callDelayMs > 0) await sleep(this.callDelayMs);
      const queue = this.failQueues[method];
      if (queue && queue.length > 0) {
        throw queue.shift() as Error;
      }
      return await fn();
    } finally {
      this.globalInFlight -= 1;
    }
  }

  login(_credentials: LoginCredentials): Promise<Session | TwoFactorChallenge> {
    return this.record('login', () => this.twoFactorChallenge ?? this.session);
  }

  completeTwoFactor(
    _challenge: TwoFactorChallenge,
    _answer: string,
    _credentials: LoginCredentials,
  ): Promise<Session> {
    return this.record('completeTwoFactor', () => this.session);
  }

  refreshSession(session: Session): Promise<Session> {
    return this.record('refreshSession', () => this.refreshedSession ?? session);
  }

  getGrades(_session: Session, _schoolYear?: string): Promise<Grade[]> {
    return this.record('getGrades', () => this.grades);
  }

  getHomework(_session: Session, _fromDate: string, _toDate: string): Promise<HomeworkItem[]> {
    return this.record('getHomework', () => this.homework);
  }

  markHomeworkDone(_session: Session, _homeworkId: string, _done: boolean): Promise<void> {
    return this.record('markHomeworkDone', () => undefined);
  }

  getTimetable(_session: Session, _fromDate: string, _toDate: string): Promise<TimetableSlot[]> {
    return this.record('getTimetable', () => this.timetable);
  }

  getSchoolLife(_session: Session): Promise<SchoolLifeEntry[]> {
    return this.record('getSchoolLife', () => this.schoolLife);
  }

  getClassLife(_session: Session): Promise<ClassLifeSummary> {
    return this.record('getClassLife', () => this.classLife);
  }

  getTimeline(_session: Session): Promise<TimelineEntry[]> {
    return this.record('getTimeline', () => this.timeline);
  }

  downloadDocument(
    _session: Session,
    _fileId: string,
    _fileType: string,
    _destinationDir: string,
  ): Promise<DownloadResult> {
    return this.record('downloadDocument', () => this.downloadResult);
  }

  getAuthStatus(session: Session | null): Promise<AuthStatus> {
    return this.record('getAuthStatus', () => ({
      sessionExists: session !== null,
      username: session?.username ?? null,
      lastRefreshAt: session?.updatedAt ?? null,
      lastErrorCode: null,
    }));
  }
}
