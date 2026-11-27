import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveKeys } from '../../src/store/secretBox.js';
import { writeSession } from '../../src/store/sessionStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { syncOwnerFromSessionFile } from '../../src/users/ownerMigration.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

let dir = '';
let users: UserStore;
let sessionPath = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-owner-'));
  users = new UserStore(join(dir, 'users'), deriveKeys('11'.repeat(32)));
  sessionPath = join(dir, 'session.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('syncOwnerFromSessionFile', () => {
  it('imports session.json as approved owner when there is no owner', async () => {
    await writeSession(makeSession({ username: 'moi', deviceUUID: 'dev-moi' }), sessionPath);
    expect(await syncOwnerFromSessionFile(users, sessionPath)).toBe('imported');
    const owner = (await users.owner())!;
    expect(owner).toMatchObject({ username: 'moi', status: 'approved', isOwner: true, deviceUUID: 'dev-moi', accountKind: 'E' });
    expect(owner.userId).toBe(users.idFor('moi'));
    expect(owner.session!.username).toBe('moi');
  });

  it('reimports a newer session.json for the same username', async () => {
    await writeSession(makeSession({ username: 'moi', updatedAt: '2026-01-01T00:00:00.000Z' }), sessionPath);
    await syncOwnerFromSessionFile(users, sessionPath);
    await writeSession(makeSession({ username: 'moi', token: 'neuf', updatedAt: '2026-02-01T00:00:00.000Z' }), sessionPath);
    expect(await syncOwnerFromSessionFile(users, sessionPath)).toBe('reimported');
    expect((await users.owner())!.session!.token).toBe('neuf');
  });

  it('ignores an older one', async () => {
    await writeSession(makeSession({ username: 'moi', token: 'actuel', updatedAt: '2026-02-01T00:00:00.000Z' }), sessionPath);
    await syncOwnerFromSessionFile(users, sessionPath);
    await writeSession(makeSession({ username: 'moi', token: 'vieux', updatedAt: '2026-01-01T00:00:00.000Z' }), sessionPath);
    expect(await syncOwnerFromSessionFile(users, sessionPath)).toBe('unchanged');
    expect((await users.owner())!.session!.token).toBe('actuel');
  });

  it('returns none without session.json', async () => {
    expect(await syncOwnerFromSessionFile(users, sessionPath)).toBe('none');
    expect(await users.owner()).toBeNull();
  });
});
