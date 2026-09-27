import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClassLife,
  fetchHomeworkForDate,
  fetchMarks,
  fetchSchoolLife,
  fetchTimeline,
  fetchTimetable,
  fetchUpcomingHomework,
  updateHomework,
} from '../../src/client/edData.js';
import { PossiblyExpiredSessionError, TokenExpiredError } from '../../src/client/errors.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

interface Call {
  url: URL;
  payload: unknown;
  token: string | null;
}

function stub(...bodies: unknown[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      const data = new URLSearchParams(String(init.body)).get('data');
      calls.push({ url, payload: data ? JSON.parse(data) : null, token: new Headers(init.headers).get('X-Token') });
      return new Response(JSON.stringify(bodies[Math.min(calls.length - 1, bodies.length - 1)]));
    }),
  );
  return calls;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const session = makeSession({
  accountId: '5618',
  accountKind: 'E',
  token: 'tok',
  accounts: [{ id: 5618, profile: { classe: { id: 77, libelle: 'TG3' } } }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('direct data calls', () => {
  it('asks for the marks of a school year, with the session token', async () => {
    const calls = stub({ code: 200, data: { notes: [], periodes: [] } });

    await fetchMarks(session, '2025-2026');
    await fetchMarks(session);

    expect(calls[0].url.pathname).toBe('/v3/eleves/5618/notes.awp');
    expect(calls[0].payload).toEqual({ anneeScolaire: '2025-2026' });
    expect(calls[0].token).toBe('tok');
    expect(calls[1].payload).toEqual({ anneeScolaire: '' });
  });

  it('asks for the timetable between two dates, without gaps', async () => {
    const calls = stub({ code: 200, data: [] });

    await fetchTimetable(session, '2026-09-28', '2026-10-03');

    expect(calls[0].url.pathname).toBe('/v3/E/5618/emploidutemps.awp');
    expect(calls[0].payload).toEqual({ dateDebut: '2026-09-28', dateFin: '2026-10-03', avecTrous: false });
  });

  it('uses the capitalised path the cahier de textes requires', async () => {
    const calls = stub({ code: 200, data: {} }, { code: 200, data: { date: '2026-09-21', matieres: [] } }, { code: 200, data: {} });

    await fetchUpcomingHomework(session);
    await fetchHomeworkForDate(session, '2026-09-21');
    await updateHomework(session, [1776], []);

    expect(calls[0].url.pathname).toBe('/v3/Eleves/5618/cahierdetexte.awp');
    expect(calls[1].url.pathname).toBe('/v3/Eleves/5618/cahierdetexte/2026-09-21.awp');
    expect(calls[2].url.pathname).toBe('/v3/Eleves/5618/cahierdetexte.awp');
    expect(calls[2].url.searchParams.get('verbe')).toBe('put');
    expect(calls[2].payload).toEqual({ idDevoirsEffectues: [1776], idDevoirsNonEffectues: [] });
  });

  it('decodes the base64 contents of homework and lessons — and nothing else', async () => {
    // Observed: only the `contenu` fields are base64. BlocksDirecte decoded
    // every string that looked like base64, which turns a 4-letter code such
    // as "ESP2" into garbage.
    stub({
      code: 200,
      data: {
        date: '2026-09-21',
        matieres: [
          {
            matiere: 'ESPAGNOL LV2',
            codeMatiere: 'ESP2',
            aFaire: {
              idDevoir: 1,
              contenu: b64('<p>127 p 389</p>'),
              effectue: false,
              contenuDeSeance: { contenu: b64('<p>correction</p>') },
            },
            contenuDeSeance: { contenu: b64('<p>Cours en mon absence.</p>') },
          },
        ],
      },
    });

    const day = await fetchHomeworkForDate(session, '2026-09-21');
    const subject = day.matieres[0];

    expect(subject.codeMatiere).toBe('ESP2');
    expect(subject.aFaire?.contenu).toBe('<p>127 p 389</p>');
    expect(subject.aFaire?.contenuDeSeance?.contenu).toBe('<p>correction</p>');
    expect(subject.contenuDeSeance?.contenu).toBe('<p>Cours en mon absence.</p>');
  });

  it('reads the class life of the account’s class, decoding its content', async () => {
    const calls = stub({ code: 200, data: { classe: 'TG3', contenu: b64('<p>Sortie</p>') } });

    const classLife = await fetchClassLife(session);

    expect(calls[0].url.pathname).toBe('/v3/Classes/77/viedelaclasse.awp');
    expect(classLife.contenu).toBe('<p>Sortie</p>');
  });

  it('treats code 210 ("Aucune donnée à afficher") as an empty answer, not an error', async () => {
    // Observed on a school life with no absence: code 210 with the full,
    // empty payload.
    stub({ code: 210, message: 'Aucune donnée à afficher  !', data: { absencesRetards: [], dispenses: [] } });

    expect(await fetchSchoolLife(session)).toEqual({ absencesRetards: [], dispenses: [] });
  });

  it('turns an empty timeline into an empty list', async () => {
    stub({ code: 210, message: 'Aucune donnée à afficher  !' });

    expect(await fetchTimeline(session)).toEqual([]);
  });

  it("surfaces École Directe's expired-token code, which the library used to swallow", async () => {
    stub({ code: 525, message: 'Token invalide !' });

    await expect(fetchMarks(session)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('still flags a 200 with no data at all', async () => {
    stub({ code: 200 });

    await expect(fetchMarks(session)).rejects.toBeInstanceOf(PossiblyExpiredSessionError);
  });
});
