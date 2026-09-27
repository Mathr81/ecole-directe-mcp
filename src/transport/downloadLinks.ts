/**
 * Temporary download links for files `download_document` saved on the server.
 *
 * Over HTTP the file sits in the container, out of the user's reach, so the
 * tool hands back a link they can open in a browser. A browser cannot attach
 * the MCP bearer token, so the link carries its own credential instead: a
 * 256-bit random token, valid for a limited time, that maps to exactly one
 * file this server wrote itself — the path never comes from the request.
 *
 * Kept in memory only: a restart forgets every link, which is the right
 * failure mode for something meant to be short-lived.
 */
import { randomBytes } from 'node:crypto';

export const DOWNLOAD_PATH_PREFIX = '/downloads/';

/** One hour: long enough to click from a chat, short enough that a leaked link soon goes dead. */
export const DEFAULT_DOWNLOAD_LINK_TTL_MS = 60 * 60 * 1000;

export interface DownloadableFile {
  path: string;
  filename: string;
  mimeType: string;
}

export interface IssuedLink {
  url: string;
  expiresAt: string;
}

export class DownloadLinks {
  private readonly entries = new Map<string, DownloadableFile & { expiresAt: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly ttlMs: number = DEFAULT_DOWNLOAD_LINK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  issue(file: DownloadableFile): IssuedLink {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, { ...file, expiresAt });
    return {
      url: new URL(`${DOWNLOAD_PATH_PREFIX}${token}`, this.baseUrl).toString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  resolve(token: string): DownloadableFile | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt < this.now()) {
      this.entries.delete(token);
      return null;
    }
    return { path: entry.path, filename: entry.filename, mimeType: entry.mimeType };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token);
    }
  }
}
