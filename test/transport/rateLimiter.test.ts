import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/transport/rateLimiter.js';

const WINDOW = 15 * 60 * 1000;

describe('RateLimiter', () => {
  it('blocks after limit hits and unblocks after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(5, WINDOW, () => now);
    for (let i = 0; i < 4; i++) limiter.hit('k');
    expect(limiter.blocked('k')).toBe(false);
    limiter.hit('k');
    expect(limiter.blocked('k')).toBe(true);
    now += WINDOW + 1;
    expect(limiter.blocked('k')).toBe(false);
  });

  it('keys are independent; reset clears one key', () => {
    const limiter = new RateLimiter(1, WINDOW, () => 0);
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.blocked('a')).toBe(true);
    limiter.reset('a');
    expect(limiter.blocked('a')).toBe(false);
    expect(limiter.blocked('b')).toBe(true);
  });
});
