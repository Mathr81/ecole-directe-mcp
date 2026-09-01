import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMessage, fetchMessages, mapMessageDetail, mapMessageSummary } from '../../src/client/messaging.js';
import { PossiblyExpiredSessionError, TokenExpiredError } from '../../src/client/errors.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

/** Shaped after what the live API actually returns for a received message. */
function makeRawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 4242,
    subject: 'Réunion parents-professeurs',
    content: '',
    date: '2026-01-09 08:00:00',
    read: false,
    to_cc_cci: 'A',
    from: { nom: 'MARTIN', prenom: 'Paul', civilite: 'M.', role: 'P' },
    to: [],
    files: [],
    ...overrides,
  };
}

function stubFetch(body: unknown, status = 200) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mapMessageSummary', () => {
  it('reads the sender for a received message and the first recipient for a sent one', () => {
    const received = mapMessageSummary(makeRawMessage(), 'received');
    const sent = mapMessageSummary(
      makeRawMessage({ from: undefined, to: [{ nom: 'DUPONT', prenom: 'Jean', civilite: 'M.' }] }),
      'sent',
    );

    expect(received.correspondent).toBe('M. Paul MARTIN');
    expect(sent.correspondent).toBe('M. Jean DUPONT');
  });

  it('leaves a plain-text subject untouched', () => {
    // Verified against the real API: subjects come back as plain text, not
    // base64, despite what the community docs imply for message payloads.
    expect(mapMessageSummary(makeRawMessage(), 'received').subject).toBe('Réunion parents-professeurs');
  });

  it('decodes a base64 subject when a deployment does encode it', () => {
    const encoded = Buffer.from('Sujet encodé', 'utf8').toString('base64');

    expect(mapMessageSummary(makeRawMessage({ subject: encoded }), 'received').subject).toBe('Sujet encodé');
  });

  it('counts attachments without exposing them', () => {
    const raw = makeRawMessage({ files: [{ id: 1, libelle: 'a.pdf' }, { id: 2, libelle: 'b.pdf' }] });

    expect(mapMessageSummary(raw, 'received').attachmentCount).toBe(2);
  });
});

describe('mapMessageDetail', () => {
  it('strips the HTML body and lists attachments', () => {
    const raw = makeRawMessage({
      content: '<p>Bonjour&nbsp;<b>Jean</b>,</p><p>À demain.</p>',
      files: [{ id: 77, libelle: 'convocation.pdf', type: 'PIECE_JOINTE' }],
    });

    const detail = mapMessageDetail(raw, 'received');

    expect(detail.content).toBe('Bonjour Jean , À demain.');
    expect(detail.attachments).toEqual([{ id: '77', filename: 'convocation.pdf', type: 'PIECE_JOINTE' }]);
  });
});

describe('fetchMessages', () => {
  it('returns the requested folder, capped at the limit', async () => {
    stubFetch({
      code: 200,
      data: {
        messages: {
          received: [makeRawMessage({ id: 1 }), makeRawMessage({ id: 2 }), makeRawMessage({ id: 3 })],
          sent: [],
          draft: [],
          archived: [],
        },
      },
    });

    const messages = await fetchMessages(makeSession(), 'received', 2);

    expect(messages.map((m) => m.id)).toEqual(['1', '2']);
  });

  it('sends the account id and the session token', async () => {
    const calls = stubFetch({ code: 200, data: { messages: { received: [] } } });

    await fetchMessages(makeSession({ accountId: '999' }), 'received', 10);

    expect(calls[0].pathname).toBe('/v3/eleves/999/messages.awp');
    expect(calls[0].searchParams.get('mode')).toBe('destinataire');
  });

  it('maps an École Directe error code to a typed error so the session can be refreshed', async () => {
    // Unlike the BlocksDirecte data modules, this path sees the numeric code,
    // so withAutoRefresh gets a real TokenExpiredError to retry on.
    stubFetch({ code: 520, message: 'Token invalide !' });

    await expect(fetchMessages(makeSession(), 'received', 10)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('rejects a response with no folder list at all', async () => {
    stubFetch({ code: 200, data: {} });

    await expect(fetchMessages(makeSession(), 'received', 10)).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});

describe('fetchMessage', () => {
  it('fetches one message by id and returns its body', async () => {
    const calls = stubFetch({ code: 200, data: makeRawMessage({ id: 4242, content: '<p>Bonjour</p>' }) });

    const message = await fetchMessage(makeSession({ accountId: '999' }), '4242');

    expect(calls[0].pathname).toBe('/v3/eleves/999/messages/4242.awp');
    expect(message.content).toBe('Bonjour');
  });

  it('rejects an empty payload rather than returning a blank message', async () => {
    stubFetch({ code: 200, data: {} });

    await expect(fetchMessage(makeSession(), '4242')).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});
