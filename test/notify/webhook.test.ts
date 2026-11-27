import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotifier } from '../../src/notify/webhook.js';

afterEach(() => vi.restoreAllMocks());

describe('createNotifier', () => {
  it('posts { content } as JSON', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await createNotifier('https://hook.example/x', fake)('x');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://hook.example/x');
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ content: 'x' });
    expect((calls[0][1].headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('swallows a failing fetch or a non-2xx answer', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    await expect(createNotifier('https://hook', failing)('x')).resolves.toBeUndefined();
    const rejected = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(createNotifier('https://hook', rejected)('x')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("createNotifier('') never calls fetch", async () => {
    const fake = vi.fn();
    await createNotifier('', fake as unknown as typeof fetch)('x');
    expect(fake).not.toHaveBeenCalled();
  });
});
