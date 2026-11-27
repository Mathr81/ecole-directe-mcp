/**
 * Encryption for the per-user files of the multi-user mode.
 *
 * One 32-byte master key (SESSION_ENCRYPTION_KEY) is split by HKDF into an
 * encryption key and an HMAC key, so the same secret never serves two
 * purposes. The key lives next to the data on the same host: this protects a
 * leaked volume or backup, not a compromised host.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export interface Keys {
  encryption: Buffer;
  hmac: Buffer;
}

export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function deriveKeys(hexKey: string): Keys {
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
    throw new Error('SESSION_ENCRYPTION_KEY doit faire 64 caractères hexadécimaux (openssl rand -hex 32).');
  }
  const master = Buffer.from(hexKey, 'hex');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return { encryption: derive('ecoledirecte-mcp:encryption'), hmac: derive('ecoledirecte-mcp:hmac') };
}

export function seal(keys: Keys, value: unknown): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Throws when the key is wrong or the payload was tampered with (GCM tag). */
export function open<T>(keys: Keys, sealed: Sealed): T {
  const decipher = createDecipheriv('aes-256-gcm', keys.encryption, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function hmacHex(keys: Keys, value: string): string {
  return createHmac('sha256', keys.hmac).update(value, 'utf8').digest('hex');
}
