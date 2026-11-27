/**
 * What happened on the server, for the admin's stats and journal.
 *
 * Only facts, never content: who (an opaque userId), what kind of event,
 * which tool, whether it worked and how long it took. No arguments, no
 * results, no names, no IP addresses. One JSON object per line, the last 30
 * days and at most `maxEvents` of them, kept in memory for the admin pages.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeJsonLinesAtomic } from '../store/atomicJson.js';

export type ActivityType =
  | 'login'
  | 'login_failed'
  | 'request'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'tool'
  | 'session_lost';

export interface ActivityEvent {
  at: string;
  type: ActivityType;
  userId?: string;
  tool?: string;
  ok?: boolean;
  ms?: number;
}

export interface ActivityLogOptions {
  now?: () => number;
  maxAgeMs?: number;
  maxEvents?: number;
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 20_000;

export class ActivityLog {
  private constructor(
    private readonly path: string,
    private list: ActivityEvent[],
    private readonly now: () => number,
    private readonly maxAgeMs: number,
    private readonly maxEvents: number,
  ) {}

  static async open(path: string, options: ActivityLogOptions = {}): Promise<ActivityLog> {
    const now = options.now ?? Date.now;
    const log = new ActivityLog(
      path,
      [],
      now,
      options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      options.maxEvents ?? DEFAULT_MAX_EVENTS,
    );
    let raw = '';
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let skipped = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        log.list.push(JSON.parse(line) as ActivityEvent);
      } catch {
        skipped = true; // a line cut by a crash mid-append
      }
    }
    if (log.trim() || skipped) await log.rewrite();
    return log;
  }

  events(): ActivityEvent[] {
    return this.list;
  }

  /** Never throws: losing one log line must not fail the request it describes. */
  async record(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    const full: ActivityEvent = { at: new Date(this.now()).toISOString(), ...event };
    this.list.push(full);
    try {
      if (this.trim()) {
        await this.rewrite();
      } else {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await appendFile(this.path, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    } catch (error) {
      console.error("Impossible d'écrire le journal d'activité :", error);
    }
  }

  /** A removed user leaves no trace in the journal. */
  async forget(userId: string): Promise<void> {
    this.list = this.list.filter((event) => event.userId !== userId);
    try {
      await this.rewrite();
    } catch (error) {
      console.error("Impossible de réécrire le journal d'activité :", error);
    }
  }

  /** Drops what is too old or over the cap; true when something went. */
  private trim(): boolean {
    const before = this.list.length;
    const limit = this.now() - this.maxAgeMs;
    this.list = this.list.filter((event) => Date.parse(event.at) >= limit);
    if (this.list.length > this.maxEvents) this.list = this.list.slice(-this.maxEvents);
    return this.list.length !== before;
  }

  private async rewrite(): Promise<void> {
    await writeJsonLinesAtomic(this.path, this.list);
  }
}
