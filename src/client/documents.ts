/**
 * Administrative documents — bulletins, certificates, invoices — over direct
 * HTTP: `@blockshub/blocksdirecte` has no module for this endpoint.
 *
 * Past years sit in an archive the request has to name: without
 * `archive=<year>` only the current year's documents are listed, and a
 * download of an archived bulletin answers X-Code 403 unless it names the
 * year too (see download.ts).
 */
import { PossiblyExpiredSessionError } from './errors.js';
import { post } from './edHttp.js';
import { mapDocuments } from './mappers.js';
import type { SchoolDocument, Session } from './types.js';

export async function fetchDocuments(session: Session, schoolYear?: string): Promise<SchoolDocument[]> {
  const query = new URLSearchParams({ verbe: 'get', archive: schoolYear ?? '' });
  const data = (await post(session, `/v3/elevesDocuments.awp?${query}`, {})) as Record<string, unknown> | undefined;
  if (!data || typeof data !== 'object') {
    throw new PossiblyExpiredSessionError(
      "École Directe n'a renvoyé aucune liste de documents — session probablement expirée.",
    );
  }
  return mapDocuments(data, schoolYear ?? null);
}
