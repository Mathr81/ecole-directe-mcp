import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from '../../src/activity/activityLog.js';

const DAY = 24 * 60 * 60 * 1000;
let dir = '';
let now = Date.parse('2026-11-27T12:00:00.000Z');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ed-activity-'));
  now = Date.parse('2026-11-27T12:00:00.000Z');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('ActivityLog', () => {
  it('records events with a timestamp and survives a restart', async () => {
    const path = join(dir, 'activity.jsonl');
    const log = await ActivityLog.open(path, { now: () => now });
    await log.record({ type: 'tool', userId: 'u1', tool: 'get_grades', ok: true, ms: 120 });
    await log.record({ type: 'login', userId: 'u1' });

    const reopened = await ActivityLog.open(path, { now: () => now });
    expect(reopened.events()).toEqual([
      { at: '2026-11-27T12:00:00.000Z', type: 'tool', userId: 'u1', tool: 'get_grades', ok: true, ms: 120 },
      { at: '2026-11-27T12:00:00.000Z', type: 'login', userId: 'u1' },
    ]);
  });

  it('drops events older than 30 days when opening', async () => {
    const path = join(dir, 'activity.jsonl');
    const old = new Date(now - 31 * DAY).toISOString();
    const recent = new Date(now - DAY).toISOString();
    await writeFile(path, `${JSON.stringify({ at: old, type: 'login' })}\n${JSON.stringify({ at: recent, type: 'login' })}\n`);

    const log = await ActivityLog.open(path, { now: () => now });

    expect(log.events().map((e) => e.at)).toEqual([recent]);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('skips a corrupt line instead of failing', async () => {
    const path = join(dir, 'activity.jsonl');
    await writeFile(path, `{oops\n${JSON.stringify({ at: new Date(now).toISOString(), type: 'login' })}\n`);
    const log = await ActivityLog.open(path, { now: () => now });
    expect(log.events()).toHaveLength(1);
  });

  it('keeps at most maxEvents, the newest ones', async () => {
    const log = await ActivityLog.open(join(dir, 'a.jsonl'), { now: () => now, maxEvents: 3 });
    for (let i = 0; i < 5; i++) {
      now += 1000;
      await log.record({ type: 'tool', tool: `t${i}` });
    }
    expect(log.events().map((e) => e.tool)).toEqual(['t2', 't3', 't4']);
  });

  it('forget removes every event of a user', async () => {
    const path = join(dir, 'activity.jsonl');
    const log = await ActivityLog.open(path, { now: () => now });
    await log.record({ type: 'login', userId: 'a' });
    await log.record({ type: 'login', userId: 'b' });
    await log.forget('a');
    expect(log.events().map((e) => e.userId)).toEqual(['b']);
    expect((await ActivityLog.open(path, { now: () => now })).events().map((e) => e.userId)).toEqual(['b']);
  });

  it('a write failure is logged, never thrown', async () => {
    const log = await ActivityLog.open(join(dir, 'missing-dir', 'nope', 'a.jsonl'), { now: () => now });
    await rm(dir, { recursive: true, force: true });
    await expect(log.record({ type: 'login' })).resolves.toBeUndefined();
  });
});
