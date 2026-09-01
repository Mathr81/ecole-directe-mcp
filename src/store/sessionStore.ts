import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Session } from '../client/types.js';

export function defaultSessionPath(): string {
  return join(homedir(), '.config', 'ecoledirecte-mcp', 'session.json');
}

export function defaultDeviceIdPath(): string {
  return join(homedir(), '.config', 'ecoledirecte-mcp', 'device-id');
}

export function resolveSessionPath(): string {
  return process.env.SESSION_PATH ?? defaultSessionPath();
}

/**
 * A session file is only usable if it carries both secrets and the account
 * list. Sessions written before those fields existed parse fine but produce
 * "Token invalide !" on every call, so they are treated as absent — the user
 * gets "run login" instead of an unexplained failure on each tool.
 */
export function isUsableSession(value: unknown): value is Session {
  const session = value as Partial<Session> | null;
  return (
    typeof session === 'object' &&
    session !== null &&
    typeof session.username === 'string' &&
    typeof session.token === 'string' &&
    session.token.length > 0 &&
    typeof session.accessToken === 'string' &&
    session.accessToken.length > 0 &&
    Array.isArray(session.accounts) &&
    session.accounts.length > 0
  );
}

export async function readSession(path: string = resolveSessionPath()): Promise<Session | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return isUsableSession(parsed) ? parsed : null;
}

export async function writeSession(session: Session, path: string = resolveSessionPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, path);
}

export async function loadOrCreateDeviceUUID(path: string = defaultDeviceIdPath()): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const uuid = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, uuid, { encoding: 'utf8', mode: 0o600 });
  return uuid;
}
