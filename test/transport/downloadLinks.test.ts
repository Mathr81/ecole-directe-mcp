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

describe('purgeOldFiles', () => {
  it('removes files older than maxAge and keeps fresh ones; a missing dir is fine', async () => {
    const { mkdtemp, readdir, rm, utimes, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { purgeOldFiles } = await import('../../src/transport/downloadLinks.js');
    const dir = await mkdtemp(join(tmpdir(), 'ed-purge-'));
    const now = Date.now();
    await writeFile(join(dir, 'vieux.pdf'), 'x');
    await writeFile(join(dir, 'neuf.pdf'), 'x');
    const old = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(join(dir, 'vieux.pdf'), old, old);

    await purgeOldFiles(dir, 60 * 60 * 1000, () => now);

    expect(await readdir(dir)).toEqual(['neuf.pdf']);
    await expect(purgeOldFiles(join(dir, 'absent'), 1000)).resolves.toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
