import { describe, expect, it } from 'vitest';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';

describe('createSessionBox', () => {
  it('returns the initial session (or null) via get()', () => {
    expect(createSessionBox(null, async () => {}).get()).toBeNull();
    const session = makeSession();
    expect(createSessionBox(session, async () => {}).get()).toEqual(session);
  });

  it('updates the in-memory value and calls persist on set()', async () => {
    const persisted: unknown[] = [];
    const box = createSessionBox(null, async (session) => { persisted.push(session); });
    const session = makeSession();

    await box.set(session);

    expect(box.get()).toEqual(session);
    expect(persisted).toEqual([session]);
  });
});
