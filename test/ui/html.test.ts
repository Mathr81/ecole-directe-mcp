import { describe, expect, it } from 'vitest';
import { initials, relativeTime } from '../../src/ui/html.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z'); // 13:00 in Paris

describe('relativeTime', () => {
  it('says times the way people do, in Paris time', () => {
    expect(relativeTime(undefined, NOW)).toBe('jamais');
    expect(relativeTime(new Date(NOW - 20_000).toISOString(), NOW)).toBe("à l'instant");
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('il y a 5 min');
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('il y a 3 h');
    expect(relativeTime('2026-11-26T17:04:00.000Z', NOW)).toBe('hier à 18:04');
    expect(relativeTime('2026-11-12T08:30:00.000Z', NOW)).toBe('le 12/11 à 09:30');
  });

  it('says today for this morning', () => {
    expect(relativeTime('2026-11-27T05:00:00.000Z', Date.parse('2026-11-27T22:00:00.000Z'))).toBe("aujourd'hui à 06:00");
  });
});

describe('initials', () => {
  it('takes the first and last word, or two letters of a single one', () => {
    expect(initials('Jean Pierre Dupont')).toBe('JD');
    expect(initials('ami')).toBe('AM');
    expect(initials('  ')).toBe('?');
  });
});
