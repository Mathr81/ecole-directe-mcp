/**
 * One encrypted file per user of the multi-user mode: `<dir>/<userId>.json`.
 *
 * The userId is an HMAC of the normalised École Directe username, so a user is
 * found without any index and file names reveal nothing. The whole record is
 * sealed, session secrets and username included.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../client/types.js';
import { writeJsonAtomic } from './atomicJson.js';
import { hmacHex, open, seal, type Keys, type Sealed } from './secretBox.js';

export type UserStatus = 'pending' | 'approved';

export interface UserRecord {
  userId: string;
  username: string;
  displayName: string;
  accountKind: string;
  status: UserStatus;
  isOwner: boolean;
  createdAt: string;
  approvedAt?: string;
  deviceUUID: string;
  session: Session | null;
}

const USER_ID = /^[0-9a-f]{64}$/;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class UserStore {
  constructor(
    private readonly dir: string,
    private readonly keys: Keys,
    private readonly now: () => number = Date.now,
  ) {}

  idFor(username: string): string {
    return hmacHex(this.keys, username.trim().toLowerCase());
  }

  private path(userId: string): string {
    return join(this.dir, `${userId}.json`);
  }

  async get(userId: string): Promise<UserRecord | null> {
    // The id becomes a file name (and may come from a URL): only our own hex ids.
    if (!USER_ID.test(userId)) return null;
    const path = this.path(userId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return open<UserRecord>(this.keys, JSON.parse(raw) as Sealed);
    } catch {
      console.error(`Fichier utilisateur illisible : ${path}`);
      return null;
    }
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.get(this.idFor(username));
  }

  async save(record: UserRecord): Promise<void> {
    await writeJsonAtomic(this.path(record.userId), seal(this.keys, record));
  }

  async delete(userId: string): Promise<void> {
    if (!USER_ID.test(userId)) return;
    await rm(this.path(userId), { force: true });
  }

  async list(): Promise<UserRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: UserRecord[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const record = await this.get(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }

  async owner(): Promise<UserRecord | null> {
    return (await this.list()).find((record) => record.isOwner) ?? null;
  }

  async countPending(): Promise<number> {
    return (await this.list()).filter((record) => record.status === 'pending').length;
  }

  async purgeExpiredPending(maxAgeMs: number = PENDING_MAX_AGE_MS): Promise<string[]> {
    const limit = this.now() - maxAgeMs;
    const expired = (await this.list()).filter(
      (record) => record.status === 'pending' && Date.parse(record.createdAt) < limit,
    );
    for (const record of expired) await this.delete(record.userId);
    return expired.map((record) => record.userId);
  }
}
