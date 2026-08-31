import type { Session } from './types.js';

export interface SessionBox {
  get(): Session | null;
  set(session: Session): Promise<void>;
}

export function createSessionBox(
  initial: Session | null,
  persist: (session: Session) => Promise<void>,
): SessionBox {
  let current = initial;
  return {
    get: () => current,
    set: async (session) => {
      current = session;
      await persist(session);
    },
  };
}
