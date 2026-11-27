import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchoolUnavailableError, TokenExpiredError } from '../../src/client/errors.js';
import type { Grade, Session } from '../../src/client/types.js';
import { deriveKeys } from '../../src/store/secretBox.js';
import { readSession } from '../../src/store/sessionStore.js';
import { UserStore, type UserRecord } from '../../src/store/userStore.js';
import { UserRuntimes } from '../../src/users/userRuntimes.js';
import { FakeEcoleDirecteClient, makeSession } from '../fakes/FakeEcoleDirecteClient.js';

class SessionRecordingFake extends FakeEcoleDirecteClient {
  seen: string[] = [];
  override getGrades(session: Session, schoolYear?: string): Promise<Grade[]> {
    this.seen.push(session.username);
    return super.getGrades(session, schoolYear);
  }
}

let dir = '';
let users: UserStore;
let fake: SessionRecordingFake;
let onAuthLost: ReturnType<typeof vi.fn>;

function record(username: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: users.idFor(username),
    username,
    displayName: username,
    accountKind: 'E',
    status: 'approved',
    isOwner: false,
    createdAt: new Date().toISOString(),
    deviceUUID: 'dev',
    // Fresh updatedAt: no proactive refresh in the way of these tests.
    session: makeSession({ username, token: `tok-${username}`, updatedAt: new Date().toISOString() }),
    ...overrides,
  };
}

function runtimes(mirror?: string) {
  return new UserRuntimes({
    users,
    base: fake,
    sessionMaxAgeMs: 15 * 60 * 1000,
    ownerSessionMirrorPath: mirror,
    onAuthLost: onAuthLost as unknown as (userId: string) => Promise<void>,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-runtimes-'));
  users = new UserStore(join(dir, 'users'), deriveKeys('11'.repeat(32)));
  fake = new SessionRecordingFake();
  onAuthLost = vi.fn(async () => {});
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('UserRuntimes', () => {
  it('get returns null for a pending user and for an unknown id', async () => {
    await users.save(record('a', { status: 'pending' }));
    const rt = runtimes();
    expect(await rt.get(users.idFor('a'))).toBeNull();
    expect(await rt.get(users.idFor('inconnu'))).toBeNull();
  });

  it('get returns the same runtime twice, and a fresh one after forget', async () => {
    await users.save(record('a'));
    const rt = runtimes();
    const first = await rt.get(users.idFor('a'));
    expect(first).not.toBeNull();
    expect(await rt.get(users.idFor('a'))).toBe(first);
    rt.forget(users.idFor('a'));
    expect(await rt.get(users.idFor('a'))).not.toBe(first);
  });

  it('two users never share a cache entry or a session', async () => {
    await users.save(record('a'));
    await users.save(record('b'));
    const rt = runtimes();
    const a = (await rt.get(users.idFor('a')))!;
    const b = (await rt.get(users.idFor('b')))!;
    await a.client.getGrades(a.sessionBox.get()!);
    await b.client.getGrades(b.sessionBox.get()!);
    expect(fake.seen).toEqual(['a', 'b']);
    expect(a.sessionBox.get()!.username).toBe('a');
    expect(b.sessionBox.get()!.username).toBe('b');
  });

  it("a refreshed session is persisted in the user's file", async () => {
    await users.save(record('a'));
    const rt = runtimes();
    const a = (await rt.get(users.idFor('a')))!;
    fake.refreshedSession = makeSession({ username: 'a', token: 'new' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    await a.client.getGrades(a.sessionBox.get()!);
    expect((await users.get(users.idFor('a')))!.session!.token).toBe('new');
  });

  it("the owner's session is mirrored to session.json, never a regular user's", async () => {
    await users.save(record('moi', { isOwner: true }));
    await users.save(record('ami'));
    const mirror = join(dir, 'session.json');
    const rt = runtimes(mirror);
    const ami = (await rt.get(users.idFor('ami')))!;
    fake.refreshedSession = makeSession({ username: 'ami', token: 'ami-new' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    await ami.client.getGrades(ami.sessionBox.get()!);
    expect(await readSession(mirror)).toBeNull();

    const owner = (await rt.get(users.idFor('moi')))!;
    fake.refreshedSession = makeSession({ username: 'moi', token: 'new' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    await owner.client.getGrades(owner.sessionBox.get()!);
    expect((await readSession(mirror))!.token).toBe('new');
  });

  it('an unrecoverable session calls onAuthLost and forgets the runtime', async () => {
    await users.save(record('a'));
    const rt = runtimes();
    const id = users.idFor('a');
    const a = (await rt.get(id))!;
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    fake.queueFailure('refreshSession', new TokenExpiredError(526, 'mort'));
    await expect(a.client.getGrades(a.sessionBox.get()!)).rejects.toThrow(/reconnecte le connecteur/);
    expect(onAuthLost).toHaveBeenCalledWith(id);
    expect(await rt.get(id)).not.toBe(a);
  });
});

describe('UserRuntimes and concurrent changes', () => {
  it('a refresh from a forgotten runtime neither resurrects nor overwrites the record', async () => {
    await users.save(record('a'));
    const rt = runtimes();
    const id = users.idFor('a');
    const old = (await rt.get(id))!;
    // A web login saved a newer session and dropped the cached runtime.
    await users.save({ ...record('a'), session: makeSession({ username: 'a', token: 'web' }) });
    rt.forget(id);
    fake.refreshedSession = makeSession({ username: 'a', token: 'stale-refresh' });
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    await old.client.getGrades(old.sessionBox.get()!);
    expect((await users.get(id))!.session!.token).toBe('web');

    await users.delete(id);
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    await old.client.getGrades(old.sessionBox.get()!);
    expect(await users.get(id)).toBeNull();
  });
});

describe('UserRuntimes and outages', () => {
  it('an École Directe outage during refresh does not call onAuthLost', async () => {
    await users.save(record('a'));
    const rt = runtimes();
    const a = (await rt.get(users.idFor('a')))!;
    fake.queueFailure('getGrades', new TokenExpiredError(525, 'expiré'));
    fake.queueFailure('refreshSession', new SchoolUnavailableError(535, 'maintenance'));

    await expect(a.client.getGrades(a.sessionBox.get()!)).rejects.toBeInstanceOf(SchoolUnavailableError);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});
