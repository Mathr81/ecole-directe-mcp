import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionPath } from './store/sessionStore.js';

export interface Config {
  sessionPath: string;
  downloadDir: string;
  readOnly: boolean;
  sessionMaxAgeMs: number;
}

const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    sessionPath: env.SESSION_PATH ?? defaultSessionPath(),
    downloadDir: env.DOWNLOAD_DIR ?? join(homedir(), '.local', 'share', 'ecoledirecte-mcp', 'downloads'),
    readOnly: parseBoolean(env.READ_ONLY, false),
    sessionMaxAgeMs: parsePositiveInt(env.SESSION_MAX_AGE_MS, DEFAULT_SESSION_MAX_AGE_MS),
  };
}
