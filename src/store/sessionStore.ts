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

export async function readSession(path: string = resolveSessionPath()): Promise<Session | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as Session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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
