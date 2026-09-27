import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDocument, parseContentDispositionFilename, safeFilename } from '../../src/client/download.js';
import { EcoleDirecteApiError, SchoolUnavailableError, TokenExpiredError } from '../../src/client/errors.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseContentDispositionFilename', () => {
  it('decodes the RFC 5987 form École Directe actually sends', () => {
    // Observed live: Attachment; filename*=UTF-8''Reglement_EPS_%C3%A9l%C3%A8ve_.docx
    const header = "Attachment; filename*=UTF-8''Reglement_EPS_%C3%A9l%C3%A8ve_.docx";

    expect(parseContentDispositionFilename(header)).toBe('Reglement_EPS_élève_.docx');
  });

  it('falls back to the quoted plain form', () => {
    expect(parseContentDispositionFilename('attachment; filename="bulletin T1.pdf"')).toBe('bulletin T1.pdf');
    expect(parseContentDispositionFilename('attachment; filename=note.pdf')).toBe('note.pdf');
  });

  it('returns undefined when there is nothing usable', () => {
    expect(parseContentDispositionFilename(undefined)).toBeUndefined();
    expect(parseContentDispositionFilename('inline')).toBeUndefined();
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''%%%")).toBeUndefined();
  });
});

describe('safeFilename', () => {
  it('keeps only the base name, so a server-sent path cannot escape the download directory', () => {
    expect(safeFilename('../../.ssh/authorized_keys', '9')).toBe('authorized_keys');
    expect(safeFilename('C:\\Windows\\evil.exe', '9')).toBe('evil.exe');
  });

  it('falls back to the file id when nothing usable remains', () => {
    expect(safeFilename('..', '627')).toBe('627');
    expect(safeFilename('   ', '627')).toBe('627');
    expect(safeFilename(undefined, '627')).toBe('627');
  });

  it('keeps accents and spaces, which are legitimate in French filenames', () => {
    expect(safeFilename('Reglement_EPS_élève_.docx', '9')).toBe('Reglement_EPS_élève_.docx');
  });
});

describe('fetchDocument', () => {
  function stubBinary(body: Uint8Array, headers: Record<string, string>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers })),
    );
  }

  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'ed-dl-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('saves the file under its real name and reports a mime type derived from it', async () => {
    // The bug this replaces: the file landed on disk as "627", with no
    // extension, because BlocksDirecte's getStream discards the response
    // headers that carry the name.
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    stubBinary(bytes, {
      'content-disposition': "Attachment; filename*=UTF-8''Reglement_EPS_%C3%A9l%C3%A8ve_.docx",
      'content-type': 'application/force-download',
    });

    const result = await withTempDir((dir) => fetchDocument(makeSession(), '627', 'PIECE_JOINTE', dir));

    expect(result.filename).toBe('Reglement_EPS_élève_.docx');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.sizeBytes).toBe(4);
    expect(result.path.endsWith('Reglement_EPS_élève_.docx')).toBe(true);
  });

  it('asks for the archive of a past school year', async () => {
    // Observed: a bulletin from last year answers X-Code 403 unless the
    // request names its archive year.
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls.push(url);
        return new Response(new Uint8Array([0x25]), { status: 200, headers: { 'content-disposition': 'attachment; filename="Note_A002.pdf"' } });
      }),
    );

    await withTempDir((dir) => fetchDocument(makeSession(), '10339', 'Note', dir, '2025-2026'));
    await withTempDir((dir) => fetchDocument(makeSession(), '2149', '', dir));

    expect(calls[0].searchParams.get('archive')).toBe('true');
    expect(calls[0].searchParams.get('anneeArchive')).toBe('2025-2026');
    expect(calls[1].searchParams.has('archive')).toBe(false);
  });

  it('prefixes an archived document with its school year, so two years never share a name', async () => {
    // Bulletins are named after their period only ("Note_A002.pdf"): the same
    // semester of two years would otherwise overwrite each other on disk.
    stubBinary(new Uint8Array([0x25]), { 'content-disposition': 'Attachment; filename="Note_A002.pdf"' });

    const archived = await withTempDir((dir) => fetchDocument(makeSession(), '10339', 'Note', dir, '2025-2026'));
    const current = await withTempDir((dir) => fetchDocument(makeSession(), '11000', 'Note', dir));

    expect(archived.filename).toBe('2025-2026_Note_A002.pdf');
    expect(archived.path.endsWith('2025-2026_Note_A002.pdf')).toBe(true);
    expect(current.filename).toBe('Note_A002.pdf');
  });

  it('writes the bytes it received', async () => {
    stubBinary(new Uint8Array([1, 2, 3, 4, 5]), { 'content-disposition': 'attachment; filename="x.bin"' });

    const bytes = await withTempDir(async (dir) => {
      const result = await fetchDocument(makeSession(), '1', 'PIECE_JOINTE', dir);
      return readFile(result.path);
    });

    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  });

  it('falls back to the file id when the server sends no name', async () => {
    stubBinary(new Uint8Array([1]), {});

    const result = await withTempDir((dir) => fetchDocument(makeSession(), '627', 'PIECE_JOINTE', dir));

    expect(result.filename).toBe('627');
    expect(result.mimeType).toBe('application/octet-stream');
  });

  it('raises a typed error instead of writing an error page to disk', async () => {
    // École Directe answers 200 with a JSON envelope when the download fails;
    // without this check that JSON was saved as if it were the document.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 520, message: 'Token invalide !' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      withTempDir((dir) => fetchDocument(makeSession(), '627', 'PIECE_JOINTE', dir)),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('refuses an HTML error page that École Directe serves with HTTP 200', async () => {
    // Asking for an unknown file id returns a 2698-byte HTML error page, not
    // JSON — with status 200. Without this check it was written to disk and
    // reported as a successful download.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html lang="fr"><title>ECOLEDIRECTE</title></html>', {
            status: 200,
            headers: { 'content-type': 'text/html', 'x-code': '403' },
          }),
      ),
    );

    await expect(
      withTempDir((dir) => fetchDocument(makeSession(), '999999', 'PIECE_JOINTE', dir)),
    ).rejects.toThrow(EcoleDirecteApiError);
  });

  it('accepts a download whose X-Code says 200', async () => {
    stubBinary(new Uint8Array([1]), { 'x-code': '200', 'content-disposition': 'attachment; filename="a.pdf"' });

    const result = await withTempDir((dir) => fetchDocument(makeSession(), '1', 'PIECE_JOINTE', dir));

    expect(result.filename).toBe('a.pdf');
  });

  it('maps other École Directe codes too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 535, message: 'Etablissement indisponible' }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          }),
      ),
    );

    await expect(
      withTempDir((dir) => fetchDocument(makeSession(), '627', 'PIECE_JOINTE', dir)),
    ).rejects.toBeInstanceOf(SchoolUnavailableError);
  });
});
