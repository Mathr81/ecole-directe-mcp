import { describe, expect, it } from 'vitest';
import { runTool } from '../../src/mcp/runTool.js';
import { createSessionBox } from '../../src/client/sessionBox.js';
import { makeSession } from '../fakes/FakeEcoleDirecteClient.js';
import { AuthenticationRequiredError, SchoolUnavailableError } from '../../src/client/errors.js';

describe('runTool', () => {
  it('returns a clear error without calling fn when the session box is empty', async () => {
    const box = createSessionBox(null, async () => {});
    let called = false;

    const result = await runTool(box, async () => {
      called = true;
      return { content: [] };
    });

    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('login');
  });

  it('calls fn with the current session when one exists', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async (session) => ({
      content: [{ type: 'text', text: session.username }],
    }));

    expect(result.content[0]?.text).toBe('jdupont');
  });

  it('converts AuthenticationRequiredError into an isError result', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async () => {
      throw new AuthenticationRequiredError();
    });

    expect(result.isError).toBe(true);
  });

  it('converts a typed EcoleDirecteApiError into an actionable isError result', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    const result = await runTool(box, async () => {
      throw new SchoolUnavailableError(535, 'école fermée');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('535');
  });

  it('rethrows unrecognized errors', async () => {
    const box = createSessionBox(makeSession(), async () => {});

    await expect(
      runTool(box, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
