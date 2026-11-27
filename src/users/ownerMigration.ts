/**
 * Keeps the owner's user record and the legacy `session.json` in step.
 *
 * The encrypted record is the source of truth in multi-user mode, but a
 * `session.json` newer than it — written by `ecoledirecte-mcp login` — wins
 * at startup, so the CLI keeps repairing the owner exactly as before.
 */
import { readSession } from '../store/sessionStore.js';
import type { UserStore } from '../store/userStore.js';

export async function syncOwnerFromSessionFile(
  users: UserStore,
  sessionPath: string,
  now: () => number = Date.now,
): Promise<'imported' | 'reimported' | 'unchanged' | 'none'> {
  const session = await readSession(sessionPath);
  if (!session) return 'none';
  const owner = await users.owner();
  if (!owner) {
    const at = new Date(now()).toISOString();
    await users.save({
      userId: users.idFor(session.username),
      username: session.username,
      displayName: session.displayName,
      accountKind: session.accountKind,
      status: 'approved',
      isOwner: true,
      createdAt: at,
      approvedAt: at,
      deviceUUID: session.deviceUUID,
      session,
    });
    return 'imported';
  }
  const sameUser = users.idFor(owner.username) === users.idFor(session.username);
  const newer = Date.parse(session.updatedAt) > Date.parse(owner.session?.updatedAt ?? '1970-01-01T00:00:00.000Z');
  if (sameUser && newer) {
    await users.save({ ...owner, session, deviceUUID: session.deviceUUID });
    return 'reimported';
  }
  return 'unchanged';
}
