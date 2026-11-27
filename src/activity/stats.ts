/** Numbers for the admin dashboard, computed from the in-memory journal. */
import type { ActivityEvent } from './activityLog.js';

const DAY = 24 * 60 * 60 * 1000;

const toolCallsSince = (events: ActivityEvent[], since: number) =>
  events.filter((e) => e.type === 'tool' && Date.parse(e.at) >= since);

export function overview(events: ActivityEvent[], now: number) {
  const week = toolCallsSince(events, now - 7 * DAY);
  return {
    calls24h: week.filter((e) => Date.parse(e.at) >= now - DAY).length,
    calls7d: week.length,
    errors7d: week.filter((e) => e.ok === false).length,
    activeUsers7d: new Set(week.map((e) => e.userId).filter(Boolean)).size,
  };
}

/** One bucket per UTC day, oldest first, the last one being today. */
export function dailyCalls(events: ActivityEvent[], now: number, days: number) {
  const buckets = new Map<string, { day: string; ok: number; errors: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    buckets.set(day, { day, ok: 0, errors: 0 });
  }
  for (const e of events) {
    if (e.type !== 'tool') continue;
    const bucket = buckets.get(e.at.slice(0, 10));
    if (bucket) bucket[e.ok === false ? 'errors' : 'ok']++;
  }
  return [...buckets.values()];
}

export function topTools(events: ActivityEvent[], now: number) {
  const counts = new Map<string, number>();
  for (const e of toolCallsSince(events, now - 7 * DAY)) {
    if (e.tool) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count);
}

export function perUser(events: ActivityEvent[], now: number) {
  const users = new Map<string, { calls7d: number; lastAt: string }>();
  const since = now - 7 * DAY;
  for (const e of events) {
    if (!e.userId) continue;
    const user = users.get(e.userId) ?? { calls7d: 0, lastAt: e.at };
    if (e.at > user.lastAt) user.lastAt = e.at;
    if (e.type === 'tool' && Date.parse(e.at) >= since) user.calls7d++;
    users.set(e.userId, user);
  }
  return users;
}
