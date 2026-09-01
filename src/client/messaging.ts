/**
 * École Directe messaging, over direct HTTP.
 *
 * `@blockshub/blocksdirecte` has no messaging module at all, so there is
 * nothing to adapt here — this is the whole implementation.
 *
 * The request contract below was verified against the live API with a real
 * account rather than inferred from documentation, and two of the plan's
 * original assumptions turned out to be wrong:
 *
 *  - `subject` is **plain text**, not base64 — but `content` *is* base64,
 *    MIME-wrapped across lines. Every text field goes through
 *    `decodeMaybeBase64`, which handles both and leaves plain text alone.
 *  - The list endpoint returns `content: ''` for every message. Bodies exist
 *    only on the per-message endpoint, which is why reading a message is a
 *    separate call (and a separate tool) rather than a flag on the list.
 */
import { EcoleDirecteApiError, PossiblyExpiredSessionError, mapErrorCode } from './errors.js';
import { stripHtml } from './mappers.js';
import type { MessageDetail, MessageFolder, MessageSummary, Session } from './types.js';

const BASE_URL = 'https://api.ecoledirecte.com';

/** Must match `edAuth`'s constants: École Directe binds a token to its User-Agent. */
const API_VERSION = '8.0.0';
const USER_AGENT =
  'BlocksDirecte/1.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148  EDMOBILE v' +
  API_VERSION;

interface RawPerson {
  nom?: string;
  prenom?: string;
  civilite?: string;
  fonctionPersonnel?: string;
}

interface RawFile {
  id?: number | string;
  libelle?: string;
  type?: string;
}

interface RawMessage {
  id: number | string;
  subject?: string;
  content?: string;
  date?: string;
  read?: boolean;
  from?: RawPerson;
  to?: RawPerson[];
  files?: RawFile[];
}

interface Envelope {
  code: number;
  message?: string;
  data?: unknown;
}

function looksBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Rejects a decode that produced binary rather than text. Ignoring whitespace
 * (below) widens what counts as base64 enough that short plain text can fall
 * into it — "Test abcd" becomes the eight valid characters "Testabcd" — and
 * decoding that yields mojibake. A replacement character means the bytes
 * weren't valid UTF-8; control characters other than tab/CR/LF appear in no
 * subject, filename or HTML body we care about.
 */
function isPlausibleText(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(value);
}

/**
 * École Directe wraps base64 bodies MIME-style, with a line break roughly
 * every 76 characters — real messages came back with 16 and 2402 whitespace
 * characters respectively. That whitespace breaks both the charset regex and
 * the length-%-4 check, so a strict test concludes "not base64" and hands the
 * caller a still-encoded body; `stripHtml` then finds no tags to remove and
 * the message reaches the agent as raw base64, at full encoded size (194 KB
 * for one message that is 142 characters of actual text).
 */
function decodeMaybeBase64(value: string | undefined): string {
  if (!value) return '';
  const compact = value.replace(/\s+/g, '');
  if (!looksBase64(compact)) return value;
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  return isPlausibleText(decoded) ? decoded : value;
}

function personName(person: RawPerson | undefined): string {
  if (!person) return '';
  return [person.civilite, person.prenom, person.nom].filter(Boolean).join(' ').trim();
}

async function post(session: Session, path: string, payload: Record<string, unknown>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('v', API_VERSION);
  const response = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams({ data: JSON.stringify(payload) }).toString(),
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
      `École Directe a répondu ${response.status} ${response.statusText} sur ${path}.`,
    );
  }
  const body = (await response.json()) as Envelope;
  if (body.code !== 200) {
    // Unlike the data modules of @blockshub/blocksdirecte, this code path does
    // see École Directe's numeric code — so 520/525 become a real
    // TokenExpiredError and withAutoRefresh can retry properly.
    throw mapErrorCode(body.code, body.message || `École Directe a renvoyé le code ${body.code}.`);
  }
  return body.data;
}

export function mapMessageSummary(raw: RawMessage, folder: MessageFolder): MessageSummary {
  return {
    id: String(raw.id),
    folder,
    subject: decodeMaybeBase64(raw.subject),
    correspondent: folder === 'received' ? personName(raw.from) : personName(raw.to?.[0]),
    date: raw.date ?? '',
    read: raw.read ?? false,
    attachmentCount: raw.files?.length ?? 0,
  };
}

export function mapMessageDetail(raw: RawMessage, folder: MessageFolder): MessageDetail {
  return {
    ...mapMessageSummary(raw, folder),
    content: stripHtml(decodeMaybeBase64(raw.content)),
    attachments: (raw.files ?? []).map((file) => ({
      id: String(file.id ?? ''),
      filename: decodeMaybeBase64(file.libelle),
      type: file.type ?? 'PIECE_JOINTE',
    })),
  };
}

export async function fetchMessages(
  session: Session,
  folder: MessageFolder,
  limit: number,
): Promise<MessageSummary[]> {
  const data = (await post(
    session,
    `/v3/eleves/${session.accountId}/messages.awp?verbe=get&mode=destinataire`,
    {},
  )) as { messages?: Partial<Record<MessageFolder, RawMessage[]>> } | undefined;
  const raw = data?.messages?.[folder];
  if (!Array.isArray(raw)) {
    throw new PossiblyExpiredSessionError(
      `École Directe n'a renvoyé aucune liste de messages pour le dossier « ${folder} » — session probablement expirée.`,
    );
  }
  return raw.slice(0, limit).map((message) => mapMessageSummary(message, folder));
}

export async function fetchMessage(session: Session, messageId: string): Promise<MessageDetail> {
  // `mode=destinataire` is what makes the API return the body of a message the
  // account received; the folder is reported as `received` accordingly.
  const data = (await post(
    session,
    `/v3/eleves/${session.accountId}/messages/${encodeURIComponent(messageId)}.awp?verbe=get&mode=destinataire`,
    {},
  )) as RawMessage | undefined;
  if (!data || data.id === undefined) {
    throw new PossiblyExpiredSessionError(
      `École Directe n'a renvoyé aucun contenu pour le message ${messageId} — session probablement expirée.`,
    );
  }
  return mapMessageDetail(data, 'received');
}
