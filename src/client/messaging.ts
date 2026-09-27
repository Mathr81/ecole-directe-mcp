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
import { PossiblyExpiredSessionError } from './errors.js';
import { post } from './edHttp.js';
import { decodeMaybeBase64 } from './base64.js';
import { stripHtml } from './mappers.js';
import type { MessageDetail, MessageFolder, MessageSummary, Session } from './types.js';

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

function personName(person: RawPerson | undefined): string {
  if (!person) return '';
  return [person.civilite, person.prenom, person.nom].filter(Boolean).join(' ').trim();
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
  // Without typeRecuperation/order/itemsPerPage the API answers with a first
  // page of 20 messages, oldest first: with 40 received, the newest 20 were
  // unreachable. `limit` is capped by the tool, so one page is enough.
  const query = new URLSearchParams({
    verbe: 'get',
    mode: 'destinataire',
    typeRecuperation: folder,
    orderBy: 'date',
    order: 'desc',
    page: '0',
    itemsPerPage: String(limit),
    getAll: '0',
  });
  const data = (await post(session, `/v3/eleves/${session.accountId}/messages.awp?${query}`, {})) as { messages?: Partial<Record<MessageFolder, RawMessage[]>> } | undefined;
  const raw = data?.messages?.[folder];
  if (!Array.isArray(raw)) {
    throw new PossiblyExpiredSessionError(
      `École Directe n'a renvoyé aucune liste de messages pour le dossier « ${folder} » — session probablement expirée.`,
    );
  }
  // Sorted here too, rather than trusting `order=desc` alone: "AAAA-MM-JJ
  // HH:MM:SS" sorts lexically in chronological order.
  return [...raw]
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, limit)
    .map((message) => mapMessageSummary(message, folder));
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
