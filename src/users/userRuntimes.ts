/**
 * Per-user session box and client, built on first use and kept in memory.
 *
 * Each user gets their own `createClient` stack, hence their own request
 * queue, cache and single in-flight refresh: one user's slow or broken
 * session never holds up or leaks into another's.
 */
import { createClient } from '../client/createClient.js';
import { AuthenticationRequiredError } from '../client/errors.js';
import { createSessionBox, type SessionBox } from '../client/sessionBox.js';
import type { EcoleDirecteClient, Session } from '../client/types.js';
import { writeSession } from '../store/sessionStore.js';
import type { UserStore } from '../store/userStore.js';

export interface UserRuntime {
  userId: string;
  isOwner: boolean;
  sessionBox: SessionBox;
  client: EcoleDirecteClient;
}

export interface UserRuntimesOptions {
  users: UserStore;
  base: EcoleDirecteClient;
  sessionMaxAgeMs: number;
  /** The owner's session is also written here, so `session.json` never goes stale. */
  ownerSessionMirrorPath?: string;
  /** The session cannot be recovered: the user must re-authorize from their AI. */
  onAuthLost: (userId: string) => Promise<void>;
}

const RECONNECT_MESSAGE = 'Ta session École Directe a expiré : déconnecte puis reconnecte le connecteur dans ton IA.';

export class UserRuntimes {
  // Promises, not runtimes: two concurrent first requests must share one runtime.
  private readonly runtimes = new Map<string, Promise<UserRuntime | null>>();

  constructor(private readonly options: UserRuntimesOptions) {}

  get(userId: string): Promise<UserRuntime | null> {
    let runtime = this.runtimes.get(userId);
    if (!runtime) {
      runtime = this.build(userId);
      this.runtimes.set(userId, runtime);
      // A null (missing, pending) is not cached: approval must take effect at once.
      void runtime.then((value) => {
        if (!value && this.runtimes.get(userId) === runtime) this.runtimes.delete(userId);
      });
    }
    return runtime;
  }

  forget(userId: string): void {
    this.runtimes.delete(userId);
  }

  private async build(userId: string): Promise<UserRuntime | null> {
    const { users, base, sessionMaxAgeMs, ownerSessionMirrorPath } = this.options;
    const record = await users.get(userId);
    if (!record || record.status !== 'approved' || !record.session) return null;

    // Assigned below; the persist callback only runs later, on a refresh.
    let self: UserRuntime | undefined;
    const sessionBox = createSessionBox(record.session, async (session: Session) => {
      const current = await users.get(userId);
      // Revoked meanwhile, or replaced by a newer runtime after a web login: keep out.
      if (!current || current.status !== 'approved' || (await this.runtimes.get(userId)) !== self) return;
      await users.save({ ...current, session });
      if (record.isOwner && ownerSessionMirrorPath) await writeSession(session, ownerSessionMirrorPath);
    });
    const client = this.withAuthLost(userId, createClient(base, sessionBox, { sessionMaxAgeMs }));
    self = { userId, isOwner: record.isOwner, sessionBox, client };
    return self;
  }

  private withAuthLost(userId: string, client: EcoleDirecteClient): EcoleDirecteClient {
    // A Proxy rather than a hand-written wrapper: every client method gets the same treatment.
    return new Proxy(client, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (error) {
            if (!(error instanceof AuthenticationRequiredError)) throw error;
            await this.options.onAuthLost(userId);
            this.forget(userId);
            throw new AuthenticationRequiredError(RECONNECT_MESSAGE);
          }
        };
      },
    });
  }
}
