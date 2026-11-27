/**
 * Fixed-window counter per key, in memory. Enough for one process; a restart
 * forgets every counter, which only ever errs towards letting someone retry.
 */
export class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.resetAt > this.now() && entry.count >= this.limit;
  }

  hit(key: string): void {
    const now = this.now();
    for (const [k, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(k);
    }
    const entry = this.entries.get(key);
    if (entry) entry.count += 1;
    else this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
