import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../../src/transport/httpAuth.js';

const TOKEN = 'f2b1c0a9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3';

describe('isAuthorized', () => {
  it('accepts the exact token', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith('3') ? '4' : '3');

    expect(isAuthorized(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it('rejects tokens of a different length instead of throwing', () => {
    // timingSafeEqual throws on a length mismatch; hashing both sides first is
    // what keeps this a plain false rather than a 500.
    expect(isAuthorized('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}extra`, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer ', TOKEN)).toBe(false);
  });

  it('requires the Bearer scheme', () => {
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
  });

  it('refuses everything when no token is configured', () => {
    // Otherwise an unset MCP_AUTH_TOKEN would turn into "any token works".
    expect(isAuthorized('Bearer ', '')).toBe(false);
    expect(isAuthorized('Bearer anything', '')).toBe(false);
    expect(isAuthorized(undefined, '')).toBe(false);
  });
});
