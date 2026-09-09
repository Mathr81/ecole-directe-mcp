/**
 * Document download, over direct HTTP.
 *
 * `@blockshub/blocksdirecte`'s `downloader.getStream()` returns only the
 * response body and discards the headers — the same shape of problem as its
 * auth module. École Directe sends the real filename in `Content-Disposition`
 * (`filename*=UTF-8''Reglement_EPS_%C3%A9l%C3%A8ve_.docx`, observed live), so
 * going through the library meant every file landed on disk named after its
 * numeric id, with no extension and an invented mime type.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EcoleDirecteApiError, PossiblyExpiredSessionError, mapErrorCode } from './errors.js';
import type { DownloadResult, Session } from './types.js';

const BASE_URL = 'https://api.ecoledirecte.com';

/** Must match `edAuth`'s constants: École Directe binds a token to its User-Agent. */
const API_VERSION = '8.0.0';
const USER_AGENT =
  'BlocksDirecte/1.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148  EDMOBILE v' +
  API_VERSION;

/**
 * École Directe answers this download with `Content-Type:
 * application/force-download` whatever the real format is, so the type is
 * derived from the extension instead.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function parseContentDispositionFilename(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  // RFC 5987 form first: it carries the charset, so accents survive.
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed percent-escape means the name can't be trusted; fall
      // through to the plain form rather than propagating a URIError.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const value = (plain?.[2] ?? plain?.[1] ?? '').trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The filename comes from the server and we use it to build a path we write
 * to, so it is reduced to a bare base name: a name like
 * `../../.ssh/authorized_keys` would otherwise place the download outside
 * DOWNLOAD_DIR.
 */
export function safeFilename(name: string | undefined, fileId: string): string {
  if (!name) return fileId;
  // Both separators, since the name is chosen by a remote Windows server.
  const base = basename(name.replace(/\\/g, '/')).trim();
  const cleaned = base.replace(/[\u0000-\u001F]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fileId;
  return cleaned.slice(0, 200);
}

function mimeFor(filename: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  return (extension && MIME_BY_EXTENSION[extension]) || 'application/octet-stream';
}

export async function fetchDocument(
  session: Session,
  fileId: string,
  fileType: string,
  destinationDir: string,
): Promise<DownloadResult> {
  const url = new URL(`${BASE_URL}/v3/telechargement.awp`);
  url.searchParams.set('verbe', 'get');
  url.searchParams.set('fichierId', fileId);
  url.searchParams.set('leTypeDeFichier', fileType);
  url.searchParams.set('v', API_VERSION);

  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({ data: JSON.stringify({ forceDownload: 0 }) }).toString(),
    headers: {
      'Content-Type': 'x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'X-Token': session.token,
    },
    redirect: 'manual',
  });

  if (!response.ok) {
    throw new EcoleDirecteApiError(
      response.status,
      `École Directe a répondu ${response.status} ${response.statusText} pour le document ${fileId}.`,
    );
  }

  // A failed download still answers HTTP 200 — École Directe reports its own
  // status in the X-Code response header instead (403 for an unknown file id,
  // served as a 2.7 KB HTML error page). Without this the page was written to
  // disk and reported as a successful download.
  const edCode = response.headers.get('x-code');
  if (edCode && edCode !== '200') {
    throw mapErrorCode(
      Number.parseInt(edCode, 10) || 0,
      `École Directe a refusé le téléchargement du document ${fileId} (code ${edCode}).`,
    );
  }

  // Older responses carry the usual JSON envelope rather than the header.
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    const body = (await response.json()) as { code?: number; message?: string };
    throw mapErrorCode(
      body.code ?? 0,
      body.message || `École Directe a refusé le téléchargement du document ${fileId}.`,
    );
  }

  if (!response.body) {
    throw new PossiblyExpiredSessionError(
      `École Directe n'a renvoyé aucun contenu pour le document ${fileId} — session probablement expirée.`,
    );
  }

  const filename = safeFilename(
    parseContentDispositionFilename(response.headers.get('content-disposition')),
    fileId,
  );
  await mkdir(destinationDir, { recursive: true });
  const path = join(destinationDir, filename);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  const { size } = await stat(path);
  return { path, filename, mimeType: mimeFor(filename), sizeBytes: size };
}
