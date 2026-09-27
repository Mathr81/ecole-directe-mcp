/**
 * Periodic check that the École Directe session still works.
 *
 * The container used to report `healthy` as long as the process was up — a
 * session killed by a revoked device id or a new QCM went unnoticed until
 * Claude's next call failed. This runs a light real call on an interval
 * (through the full client, so an expired token is refreshed like on any
 * other call) and keeps the outcome for `/health`, which turns it into a 503
 * for the Docker healthcheck and for external monitoring (Uptime Kuma, Gatus)
 * to alert on. Alerting itself is theirs, not this server's.
 *
 * One failure is not enough to report the session broken: a network blip
 * would otherwise raise an alert. Recovery is immediate.
 */
import {
  AuthenticationRequiredError,
  InvalidCredentialsError,
  SchoolUnavailableError,
  TokenExpiredError,
} from '../client/errors.js';

export type HealthStatus = 'unknown' | 'ok' | 'failing';

/** Coarse on purpose: /health answers without a token, so no error detail leaves the server. */
export type FailureReason = 'no_session' | 'auth_required' | 'school_unavailable' | 'error';

export interface HealthState {
  status: HealthStatus;
  reason: FailureReason | null;
  /** When the current status began. */
  since: string | null;
  checkedAt: string | null;
}

export class NoSessionError extends Error {}

export interface SessionMonitorOptions {
  check: () => Promise<void>;
  intervalMs: number;
  /** Consecutive failures before reporting `failing`. */
  failureThreshold?: number;
  now?: () => number;
}

function classify(error: unknown): FailureReason {
  if (error instanceof NoSessionError) return 'no_session';
  if (
    error instanceof AuthenticationRequiredError ||
    error instanceof TokenExpiredError ||
    error instanceof InvalidCredentialsError
  ) {
    return 'auth_required';
  }
  if (error instanceof SchoolUnavailableError) return 'school_unavailable';
  return 'error';
}

export class SessionMonitor {
  private current: HealthState = { status: 'unknown', reason: null, since: null, checkedAt: null };
  private consecutiveFailures = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly failureThreshold: number;

  constructor(private readonly options: SessionMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.failureThreshold = options.failureThreshold ?? 2;
  }

  state(): HealthState {
    return { ...this.current };
  }

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    // The HTTP server keeps the process alive; this timer must not.
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async runOnce(): Promise<void> {
    try {
      await this.options.check();
      this.consecutiveFailures = 0;
      this.update('ok', null);
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.update('failing', classify(error));
      } else {
        this.current = { ...this.current, checkedAt: this.timestamp() };
      }
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private update(status: HealthStatus, reason: FailureReason | null): void {
    const checkedAt = this.timestamp();
    const changed = status !== this.current.status || reason !== this.current.reason;
    this.current = { status, reason, since: changed ? checkedAt : this.current.since, checkedAt };
  }
}
