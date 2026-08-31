import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateDeviceUUID, readSession, writeSession } from '../../src/store/sessionStore.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

describe('sessionStore', () => {
  let dir: string;
  let sessionPath: string;
  let deviceIdPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ecoledirecte-mcp-test-'));
    sessionPath = join(dir, 'nested', 'session.json');
    deviceIdPath = join(dir, 'nested', 'device-id');
  });

  it('writes and reads back a session, creating parent directories', async () => {
    const session = makeSession();
    await writeSession(session, sessionPath);

    const read = await readSession(sessionPath);

    expect(read).toEqual(session);
  });

  it('returns null when no session file exists', async () => {
    expect(await readSession(sessionPath)).toBeNull();
  });

  it('writes the session file with 0o600, the parent dir with 0o700, and leaves no temp file behind', async () => {
    await writeSession(makeSession(), sessionPath);

    const fileStats = await stat(sessionPath);
    expect(fileStats.mode & 0o777).toBe(0o600);

    const dirStats = await stat(join(dir, 'nested'));
    expect(dirStats.mode & 0o777).toBe(0o700);

    const entries = await readdir(join(dir, 'nested'));
    expect(entries.sort()).toEqual(['session.json']);
  });

  it('generates a deviceUUID once and persists it immediately, before any session exists', async () => {
    const uuid = await loadOrCreateDeviceUUID(deviceIdPath);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);

    const persisted = (await readFile(deviceIdPath, 'utf8')).trim();
    expect(persisted).toBe(uuid);
  });

  it('reuses the persisted deviceUUID on subsequent calls instead of generating a new one', async () => {
    const first = await loadOrCreateDeviceUUID(deviceIdPath);
    const second = await loadOrCreateDeviceUUID(deviceIdPath);
    expect(second).toBe(first);
  });

  afterEach(async () => {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });
});
