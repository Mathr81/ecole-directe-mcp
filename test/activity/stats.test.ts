import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../src/activity/activityLog.js';
import { dailyCalls, overview, perUser, topTools } from '../../src/activity/stats.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const H = 60 * 60 * 1000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const events: ActivityEvent[] = [
  { at: at(1 * H), type: 'tool', userId: 'a', tool: 'get_grades', ok: true },
  { at: at(2 * H), type: 'tool', userId: 'a', tool: 'get_homework', ok: false },
  { at: at(30 * H), type: 'tool', userId: 'b', tool: 'get_grades', ok: true },
  { at: at(10 * 24 * H), type: 'tool', userId: 'b', tool: 'get_grades', ok: true },
  { at: at(3 * H), type: 'login', userId: 'b' },
];

describe('stats', () => {
  it('overview counts calls over 24 h and 7 days, errors and active users', () => {
    expect(overview(events, NOW)).toEqual({ calls24h: 2, calls7d: 3, errors7d: 1, activeUsers7d: 2 });
  });

  it('dailyCalls returns one bucket per day, oldest first, ok and errors apart', () => {
    const days = dailyCalls(events, NOW, 3);
    expect(days).toEqual([
      { day: '2026-11-25', ok: 0, errors: 0 },
      { day: '2026-11-26', ok: 1, errors: 0 },
      { day: '2026-11-27', ok: 1, errors: 1 },
    ]);
  });

  it('topTools ranks tools over the last 7 days', () => {
    expect(topTools(events, NOW)).toEqual([
      { tool: 'get_grades', count: 2 },
      { tool: 'get_homework', count: 1 },
    ]);
  });

  it('perUser gives the calls of the last 7 days and the last activity of any kind', () => {
    const users = perUser(events, NOW);
    expect(users.get('a')).toEqual({ calls7d: 2, lastAt: at(1 * H) });
    expect(users.get('b')).toEqual({ calls7d: 1, lastAt: at(3 * H) });
  });
});
