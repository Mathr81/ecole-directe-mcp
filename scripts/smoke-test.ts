/**
 * Manual end-to-end check against a real École Directe account. Never run in
 * CI: it makes real API calls with the session `ecoledirecte-mcp login` saved.
 *
 * Run with `npm run smoke-test`.
 */
import { createBlocksDirecteClient } from '../src/client/blocksDirecteAdapter.js';
import { createClient } from '../src/client/createClient.js';
import { createSessionBox } from '../src/client/sessionBox.js';
import { loadConfig } from '../src/config.js';
import { readSession, resolveSessionPath, writeSession } from '../src/store/sessionStore.js';
import type { Session } from '../src/client/types.js';

function preview(label: string, value: unknown): void {
  const shown = Array.isArray(value) ? value.slice(0, 3) : value;
  const count = Array.isArray(value) ? ` (${value.length} au total)` : '';
  console.log(`\n=== ${label}${count}`);
  console.log(JSON.stringify(shown, null, 2));
}

async function step(label: string, run: () => Promise<unknown>): Promise<boolean> {
  try {
    preview(label, await run());
    return true;
  } catch (error) {
    // Keep going: one failing endpoint shouldn't hide the state of the others,
    // which is the whole point of a smoke test.
    console.error(`\n=== ${label} — ÉCHEC`);
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const session = await readSession(config.sessionPath);
  if (!session) {
    throw new Error(
      `Aucune session exploitable dans ${resolveSessionPath()}. Lance d'abord \`node dist/cli/index.js login\`.`,
    );
  }

  // No pre-emptive refreshSession here, deliberately: the stored session is
  // self-sufficient, and a re-login spends the one credential that can recover
  // an expired token. An expired token surfaces below, where withAutoRefresh
  // refreshes once and retries — which is exactly the path worth exercising.
  const sessionBox = createSessionBox(session, (updated) => writeSession(updated, config.sessionPath));
  const client = createClient(createBlocksDirecteClient(), sessionBox, {
    sessionMaxAgeMs: config.sessionMaxAgeMs,
  });
  // Seeded non-null just above, and nothing in this single-shot script clears it.
  const current = (): Session => sessionBox.get()!;

  const today = new Date().toISOString().slice(0, 10);
  const in14Days = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const results = [
    await step('getAuthStatus', () => client.getAuthStatus(current())),
    await step('getGrades', () => client.getGrades(current())),
    await step('getHomework', () => client.getHomework(current(), today, in14Days)),
    await step('getTimetable', () => client.getTimetable(current(), today, in14Days)),
    await step('getSchoolLife', () => client.getSchoolLife(current())),
    await step('getClassLife', () => client.getClassLife(current())),
    await step('getTimeline', () => client.getTimeline(current())),
  ];

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n---\nSession : ${resolveSessionPath()}`);
  console.log(`Résultat : ${results.length - failed}/${results.length} appels réussis.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
