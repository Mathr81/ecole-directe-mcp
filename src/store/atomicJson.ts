import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Writes JSON through a temp file and a rename, so a crash mid-write can never
 * leave a half-written file behind — the same guarantee the session file has
 * always had, extracted here because the OAuth store needs it too.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, path);
}

/** Returns `fallback` when the file is missing or unparseable. */
export async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}
