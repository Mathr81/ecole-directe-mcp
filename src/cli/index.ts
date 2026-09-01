#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createBlocksDirecteClient } from '../client/blocksDirecteAdapter.js';
import { createClient } from '../client/createClient.js';
import { createSessionBox } from '../client/sessionBox.js';
import { loadConfig } from '../config.js';
import { loadOrCreateDeviceUUID, readSession, resolveSessionPath, writeSession } from '../store/sessionStore.js';
import { runLoginFlow, type LoginIO } from './login.js';
import { startStdioServer } from '../transport/stdio.js';

async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(question);
    let buffer = '';
    const onData = (char: Buffer) => {
      const c = char.toString('utf8');
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(buffer);
        return;
      }
      if (c === '\u0003') process.exit(1);
      if (c === '\u007f') {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += c;
    };
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
  });
}

const readlineIO: LoginIO = {
  async chooseAnswer(question, propositions) {
    console.log(`\nQuestion de sécurité École Directe :\n${question}\n`);
    propositions.forEach((p, i) => console.log(`  ${i + 1}) ${p}`));
    const raw = await promptVisible('\nVotre réponse (numéro) : ');
    const index = Number.parseInt(raw, 10) - 1;
    return propositions[index] ?? raw;
  },
};

async function runLoginCommand(): Promise<void> {
  const username = await promptVisible('Identifiant École Directe : ');
  const password = await promptHidden('Mot de passe : ');
  const deviceUUID = await loadOrCreateDeviceUUID();
  const client = createBlocksDirecteClient();
  const session = await runLoginFlow(client, readlineIO, { username, password, deviceUUID });
  await writeSession(session);
  console.log(`\nConnecté en tant que ${session.displayName}. Session enregistrée dans ${resolveSessionPath()}.`);
}

async function runServeCommand(useHttp: boolean): Promise<void> {
  if (useHttp) {
    console.error('Le transport HTTP arrive en V2. Utilise `ecoledirecte-mcp serve` (stdio) pour l\'instant.');
    process.exit(1);
  }
  const config = loadConfig();
  const base = createBlocksDirecteClient();
  // No refresh here: the stored session already carries everything the client
  // needs, and a re-login on every startup burns the one credential that can
  // recover an expired token. A token that really has expired surfaces on the
  // first data call, where `withAutoRefresh` refreshes once and retries.
  const initialSession = await readSession(config.sessionPath);
  if (!initialSession) {
    console.error(
      "Aucune session exploitable trouvée. `get_auth_status` le signalera. Lance `ecoledirecte-mcp login` dans un autre terminal pour t'authentifier.",
    );
  }

  const sessionBox = createSessionBox(initialSession, (session) => writeSession(session, config.sessionPath));
  const client = createClient(base, sessionBox, { sessionMaxAgeMs: config.sessionMaxAgeMs });
  await startStdioServer({ client, sessionBox, config });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      http: { type: 'boolean', default: false },
      'read-only': { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values['read-only'] !== undefined) {
    process.env.READ_ONLY = String(values['read-only']);
  }
  if (command === 'login') {
    await runLoginCommand();
  } else if (command === 'serve') {
    await runServeCommand(Boolean(values.http));
  } else {
    console.error('Usage: ecoledirecte-mcp <login|serve> [--http] [--read-only]');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
