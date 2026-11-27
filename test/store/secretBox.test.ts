import { describe, expect, it } from 'vitest';
import { deriveKeys, hmacHex, open, seal } from '../../src/store/secretBox.js';

const keys = deriveKeys('11'.repeat(32));
const otherKeys = deriveKeys('22'.repeat(32));

describe('secretBox', () => {
  it('deriveKeys throws on a key that is not 64 hex characters', () => {
    expect(() => deriveKeys('abc')).toThrow(/SESSION_ENCRYPTION_KEY/);
    expect(() => deriveKeys('zz'.repeat(32))).toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it('seal/open round-trips, with a fresh IV every time', () => {
    const a = seal(keys, { a: 1 });
    const b = seal(keys, { a: 1 });
    expect(open(keys, a)).toEqual({ a: 1 });
    expect(a.iv).not.toBe(b.iv);
  });

  it('open fails with another key or a tampered payload', () => {
    const sealed = seal(keys, { secret: 'x' });
    expect(() => open(otherKeys, sealed)).toThrow();
    const flipped = sealed.data[0] === 'A' ? 'B' : 'A';
    expect(() => open(keys, { ...sealed, data: flipped + sealed.data.slice(1) })).toThrow();
  });

  it('hmacHex is stable and key-dependent', () => {
    expect(hmacHex(keys, 'jdupont')).toBe(hmacHex(keys, 'jdupont'));
    expect(hmacHex(keys, 'jdupont')).not.toBe(hmacHex(otherKeys, 'jdupont'));
  });
});
