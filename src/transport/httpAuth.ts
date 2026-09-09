import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, and padding
 * them would leak the expected token's length through timing. Both sides are
 * therefore hashed to a fixed 32 bytes first, and the digests compared — the
 * comparison then takes the same time whatever the input.
 */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  // No configured token means nothing can authenticate. Callers refuse to
  // start in that case; this is the second line of defence.
  if (!expectedToken) return false;
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) return false;
  const provided = authorizationHeader.slice(BEARER_PREFIX.length);
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
