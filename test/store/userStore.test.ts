import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKeys } from '../../src/store/secretBox.js';
import { UserStore, type UserRecord } from '../../src/store/userStore.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
let dir = '';

function record(store: UserStore, username: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: store.idFor(username),
    username,
    displayName: username,
    accountKind: 'E',
    status: 'approved',
    isOwner: false,
    createdAt: new Date(NOW).toISOString(),
    deviceUUID: 'dev',
    session: makeSession({ username }),
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-users-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const storeWith = (hex = '11') => new UserStore(dir, deriveKeys(hex.repeat(32)), () => NOW);

describe('UserStore', () => {
  it('idFor normalises case and whitespace', () => {
    const store = storeWith();
    expect(store.idFor(' JDupont ')).toBe(store.idFor('jdupont'));
    expect(store.idFor('jdupont')).not.toBe(store.idFor('autre'));
  });

  it('save then get and findByUsername return the record', async () => {
    const store = storeWith();
    const r = record(store, 'jdupont');
    await store.save(r);
    expect(await store.get(r.userId)).toEqual(r);
    expect(await store.findByUsername('JDupont')).toEqual(r);
    expect(await store.get('inconnu')).toBeNull();
  });

  it('the file on disk contains neither the username nor the token', async () => {
    const store = storeWith();
    const r = record(store, 'jdupont');
    await store.save(r);
    const raw = await readFile(join(dir, `${r.userId}.json`), 'utf8');
    expect(raw).not.toContain('jdupont');
    expect(raw).not.toContain('fake-access-token');
  });

  it('get returns null and list skips a file sealed with another key', async () => {
    const a = storeWith('11');
    const r = record(a, 'jdupont');
    await a.save(r);
    const b = storeWith('22');
    await expect(b.get(r.userId)).resolves.toBeNull();
    await expect(b.list()).resolves.toEqual([]);
  });

  it('list skips a truncated file', async () => {
    const store = storeWith();
    const r = record(store, 'jdupont');
    await store.save(r);
    await writeFile(join(dir, 'x.json'), '{');
    expect(await store.list()).toEqual([r]);
  });

  it('owner returns the isOwner record or null', async () => {
    const store = storeWith();
    await store.save(record(store, 'ami'));
    expect(await store.owner()).toBeNull();
    const owner = record(store, 'moi', { isOwner: true });
    await store.save(owner);
    expect(await store.owner()).toEqual(owner);
  });

  it('purgeExpiredPending deletes pending records older than 7 days and keeps approved ones', async () => {
    const store = storeWith();
    const old = new Date(NOW - 8 * DAY).toISOString();
    const stale = record(store, 'vieux', { status: 'pending', createdAt: old });
    const fresh = record(store, 'recent', { status: 'pending' });
    const approved = record(store, 'valide', { createdAt: old });
    await Promise.all([stale, fresh, approved].map((r) => store.save(r)));
    expect(await store.purgeExpiredPending()).toEqual([stale.userId]);
    expect(await store.get(stale.userId)).toBeNull();
    expect(await store.get(fresh.userId)).not.toBeNull();
    expect(await store.get(approved.userId)).not.toBeNull();
  });

  it('countPending counts only pending', async () => {
    const store = storeWith();
    await store.save(record(store, 'a', { status: 'pending' }));
    await store.save(record(store, 'b', { status: 'pending' }));
    await store.save(record(store, 'c'));
    expect(await store.countPending()).toBe(2);
  });

  it('delete removes the record and ignores an unknown id', async () => {
    const store = storeWith();
    const r = record(store, 'a');
    await store.save(r);
    await store.delete(r.userId);
    await store.delete(r.userId);
    expect(await store.get(r.userId)).toBeNull();
  });
});
