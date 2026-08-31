import { createCachingClient } from './cachingClient.js';
import { withAutoRefresh, type WithAutoRefreshOptions } from './errors.js';
import type { SessionBox } from './sessionBox.js';
import type { EcoleDirecteClient } from './types.js';

export interface CreateClientOptions {
  sessionMaxAgeMs?: number;
  /** Injectable clock, tests only — forwarded to withAutoRefresh. */
  now?: () => number;
}

export function createClient(
  base: EcoleDirecteClient,
  sessionBox: SessionBox,
  options: CreateClientOptions = {},
): EcoleDirecteClient {
  const refreshOptions: WithAutoRefreshOptions = { maxAgeMs: options.sessionMaxAgeMs, now: options.now };
  return createCachingClient(withAutoRefresh(base, sessionBox, refreshOptions));
}
