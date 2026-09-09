import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultSessionPath } from './store/sessionStore.js';

export interface HttpConfig {
  /** Interface to bind. Never 0.0.0.0 by default — see `DEFAULT_HTTP_HOST`. */
  host: string;
  port: number;
  /** Required to serve over HTTP; empty means "refuse to start". */
  authToken: string;
  /** Host headers accepted by the DNS-rebinding guard. */
  allowedHosts: string[];
}

export interface Config {
  sessionPath: string;
  downloadDir: string;
  readOnly: boolean;
  sessionMaxAgeMs: number;
  http: HttpConfig;
}

const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Loopback, deliberately. On the VPS this is set to the Tailscale interface
 * address so the server is reachable from the tailnet and nowhere else;
 * defaulting to 0.0.0.0 would publish it to the open internet the first time
 * someone forgot to set it.
 */
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_PORT = 8787;

export interface LoadConfigOptions {
  /**
   * Default for READ_ONLY when the environment doesn't set it. `false` for
   * stdio (single user, at their own keyboard), `true` for HTTP.
   */
  readOnlyDefault?: boolean;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): Config {
  const host = env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const port = parsePositiveInt(env.MCP_HTTP_PORT, DEFAULT_HTTP_PORT);
  const configuredHosts = parseList(env.MCP_ALLOWED_HOSTS);
  return {
    sessionPath: env.SESSION_PATH ?? defaultSessionPath(),
    downloadDir: env.DOWNLOAD_DIR ?? join(homedir(), '.local', 'share', 'ecoledirecte-mcp', 'downloads'),
    readOnly: parseBoolean(env.READ_ONLY, options.readOnlyDefault ?? false),
    sessionMaxAgeMs: parsePositiveInt(env.SESSION_MAX_AGE_MS, DEFAULT_SESSION_MAX_AGE_MS),
    http: {
      host,
      port,
      authToken: env.MCP_AUTH_TOKEN ?? '',
      // The bound address is always acceptable; anything else has to be named
      // explicitly, since the guard's whole job is to reject unexpected Hosts.
      allowedHosts: configuredHosts.length > 0 ? configuredHosts : [`${host}:${port}`, host],
    },
  };
}
