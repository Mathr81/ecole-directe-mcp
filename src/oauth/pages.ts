/** Pages of the connection flow: what a friend sees after clicking "Se connecter" in their AI. */
import { brand, escapeHtml, icon, page, type IconName } from '../ui/html.js';

export { escapeHtml };

type Step = 'login' | 'waiting' | 'ready';

/** The three moments of a first connection, so nobody wonders what comes next. */
function steps(current: Step): string {
  const order: Step[] = ['login', 'waiting', 'ready'];
  const labels: Record<Step, string> = { login: 'Connexion', waiting: 'Validation', ready: "C'est prêt" };
  const at = order.indexOf(current);
  const items = order.map((step, index) => {
    const state =
      index < at ? 'is-done' : index > at ? '' : current === 'waiting' ? 'is-current is-waiting' : 'is-current';
    return `<li class="${state}"${index === at ? ' aria-current="step"' : ''}>${labels[step]}</li>`;
  });
  return `<ol class="steps" aria-label="Étapes">${items.join('')}</ol>`;
}

function flow(title: string, inner: string, foot = ''): string {
  return page({
    title,
    body: `<main class="flow"><div class="flow-inner">
${brand()}
${inner}
${foot ? `<div class="flow-foot">${foot}</div>` : ''}
</div></main>`,
  });
}

function note(tone: 'error' | 'warning', text: string): string {
  return `<div class="note is-${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${icon('alert')}<p>${text}</p></div>`;
}

const PRIVACY = `<p>Ce serveur garde ta session École Directe chiffrée, jamais ton mot de passe. Tes données passent par l'IA que tu connectes. Le propriétaire du serveur gère les accès : demande-lui pour être supprimé.</p>
<p><a href="/">Comment ça marche ?</a></p>`;

export interface LoginPageOptions {
  pendingId: string;
  /** As the client registered itself — untrusted. */
  clientName: string;
  /** Host the authorization code is sent to — the one thing a fake client cannot disguise. */
  redirectHost: string;
  action: string;
  error?: string;
}

/** Hosts of the AI apps this server is known to be used with. */
const KNOWN_REDIRECT_HOSTS = ['claude.ai', 'claude.com'];

export function renderLoginPage({ pendingId, clientName, redirectHost, action, error }: LoginPageOptions): string {
  const warning = KNOWN_REDIRECT_HOSTS.includes(redirectHost)
    ? ''
    : note('warning', "<strong>Attention : ce n'est pas Claude.</strong> Ne te connecte que si tu as toi-même ajouté ce connecteur dans ton IA.");
  return flow(
    'Connexion',
    `${steps('login')}
<section class="panel" aria-labelledby="title">
  <h1 id="title">Connecte-toi à École Directe</h1>
  <div class="who">${icon('plug')}<p><strong>${escapeHtml(clientName)}</strong> demande à lire ton compte. Après la connexion, tu seras renvoyé vers <strong>${escapeHtml(redirectHost)}</strong>.</p></div>
  ${warning}
  ${error ? note('error', escapeHtml(error)) : ''}
  <form method="post" action="${escapeHtml(action)}" data-busy="Connexion à École Directe…">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <div class="field">
      <label for="username">Identifiant École Directe</label>
      <input class="input" id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" autofocus required>
    </div>
    <div class="field">
      <label for="password">Mot de passe</label>
      <div class="password">
        <input class="input" id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="button" class="reveal" data-reveal="password" aria-pressed="false" hidden>Afficher</button>
      </div>
    </div>
    <button class="btn is-block" type="submit">Se connecter</button>
  </form>
</section>`,
    `<p><strong>Ce que ton IA pourra lire :</strong> notes et moyennes, devoirs, emploi du temps, vie scolaire, documents, et ta messagerie en lecture seule.</p>
${PRIVACY}`,
  );
}

export interface TwoFactorPageOptions {
  pendingId: string;
  question: string;
  propositions: string[];
  action: string;
  error?: string;
}

export function renderTwoFactorPage({ pendingId, question, propositions, action, error }: TwoFactorPageOptions): string {
  const choices = propositions
    .map(
      (proposition, index) =>
        `<label class="choice"><input type="radio" name="answer" value="${escapeHtml(proposition)}"${index === 0 ? ' required' : ''}> ${escapeHtml(proposition)}</label>`,
    )
    .join('\n      ');
  return flow(
    'Question de sécurité',
    `${steps('login')}
<section class="panel" aria-labelledby="title">
  <h1 id="title">Une dernière question</h1>
  <p>École Directe vérifie que c'est bien toi, comme sur l'appli.</p>
  ${error ? note('error', escapeHtml(error)) : ''}
  <form method="post" action="${escapeHtml(action)}" data-busy="Vérification…">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <fieldset class="choices">
      <legend class="field"><strong>${escapeHtml(question)}</strong></legend>
      ${choices}
    </fieldset>
    <button class="btn is-block" type="submit">Valider ma réponse</button>
  </form>
</section>`,
    PRIVACY,
  );
}

export type MessageTone = 'error' | 'pending' | 'info';

export interface MessagePageOptions {
  title: string;
  message: string;
  /** `pending` shows where the request stands; `error` offers the way back. */
  tone?: MessageTone;
}

const EMBLEMS: Record<MessageTone, { glyph: IconName; fill: string }> = {
  pending: { glyph: 'hourglass', fill: '#ffd23f' },
  error: { glyph: 'alert', fill: '#ffe7e2' },
  info: { glyph: 'school', fill: '#dfe5f7' },
};

export function renderMessagePage({ title, message, tone = 'info' }: MessagePageOptions): string {
  const { glyph, fill } = EMBLEMS[tone];
  const inner = icon(glyph).replace(/^<svg[^>]*>|<\/svg>$/g, '');
  const art = `<svg class="big-emblem" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="${fill}" stroke="#14193a" stroke-width="3"/><g transform="translate(16 16) scale(1.33)" fill="none" stroke="#14193a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  const next =
    tone === 'pending'
      ? `<p class="muted small">Rien d'autre à faire pour l'instant, tu peux fermer cette page.</p>`
      : `<p><a class="btn is-ghost" href="/">Revoir le tuto</a></p>`;
  return flow(
    title,
    `${tone === 'pending' ? steps('waiting') : ''}
<section class="panel" aria-labelledby="title">
  ${art}
  <h1 id="title">${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  ${next}
</section>`,
  );
}
