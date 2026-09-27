import { describe, expect, it } from 'vitest';
import { DOWNLOAD_PATH_PREFIX, DownloadLinks } from '../../src/transport/downloadLinks.js';

const file = { path: '/data/downloads/reglement.docx', filename: 'Règlement EPS.docx', mimeType: 'application/pdf' };

describe('DownloadLinks', () => {
  it('issues an unguessable link under the base URL that resolves back to the file', () => {
    const links = new DownloadLinks('https://ed.example.fr', 60_000);

    const link = links.issue(file);
    const url = new URL(link.url);
    const token = url.pathname.slice(DOWNLOAD_PATH_PREFIX.length);

    expect(url.origin).toBe('https://ed.example.fr');
    expect(url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)).toBe(true);
    // 32 random bytes, base64url: the token is the only credential.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.resolve(token)).toEqual(file);
  });

  it('issues a different token every time', () => {
    const links = new DownloadLinks('https://ed.example.fr', 60_000);

    expect(links.issue(file).url).not.toBe(links.issue(file).url);
  });

  it('stops resolving a link once it has expired', () => {
    let now = 1_000_000;
    const links = new DownloadLinks('https://ed.example.fr', 60_000, () => now);
    const link = links.issue(file);
    const token = new URL(link.url).pathname.slice(DOWNLOAD_PATH_PREFIX.length);

    expect(link.expiresAt).toBe(new Date(1_060_000).toISOString());
    now += 60_001;

    expect(links.resolve(token)).toBeNull();
  });

  it('resolves nothing for an unknown token', () => {
    expect(new DownloadLinks('https://ed.example.fr', 60_000).resolve('nope')).toBeNull();
  });
});
