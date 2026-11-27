/** The owner's pages: dashboard, people, one person, journal. */
import type { ActivityEvent } from '../activity/activityLog.js';
import { dailyCalls, overview, perUser, topTools } from '../activity/stats.js';
import type { HealthState } from '../health/sessionMonitor.js';
import type { UserRecord } from '../store/userStore.js';
import { brand, escapeHtml, icon, initials, page, relativeTime, type IconName } from '../ui/html.js';

const TOOL_LABELS: Record<string, string> = {
  get_grades: 'Notes',
  get_averages: 'Moyennes',
  get_homework: 'Devoirs',
  get_timetable: 'Emploi du temps',
  get_school_life: 'Vie scolaire',
  get_class_life: 'Vie de classe',
  get_timeline: "Fil d'actualité",
  get_auth_status: 'État de connexion',
  mark_homework_done: 'Devoir coché',
  get_documents: 'Documents',
  download_document: 'Téléchargement',
  get_messages: 'Messagerie',
  read_message: 'Lecture de message',
  get_workspaces: 'Espaces de travail',
  get_workspace_files: "Fichiers d'espace",
};

/** What the journal says someone did. */
const TOOL_ACTIONS: Record<string, string> = {
  get_grades: 'a consulté ses notes',
  get_averages: 'a consulté ses moyennes',
  get_homework: 'a consulté ses devoirs',
  get_timetable: 'a consulté son emploi du temps',
  get_school_life: 'a consulté sa vie scolaire',
  get_class_life: 'a consulté la vie de classe',
  get_timeline: "a consulté son fil d'actualité",
  get_auth_status: "a vérifié sa connexion",
  mark_homework_done: 'a coché un devoir',
  get_documents: 'a consulté ses documents',
  download_document: 'a téléchargé un document',
  get_messages: 'a consulté sa messagerie',
  read_message: 'a lu un message',
  get_workspaces: 'a consulté ses espaces de travail',
  get_workspace_files: "a ouvert un espace de travail",
};

const toolLabel = (tool: string | undefined) => (tool ? (TOOL_LABELS[tool] ?? tool) : 'outil inconnu');
const toolAction = (tool: string | undefined) => (tool && TOOL_ACTIONS[tool]) ?? `a utilisé ${toolLabel(tool)}`;
const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

type Section = 'dashboard' | 'users' | 'activity';

function shell(title: string, section: Section, pendingCount: number, main: string): string {
  const link = (href: string, id: Section, label: string, extra = '') =>
    `<a href="${href}"${id === section ? ' aria-current="page"' : ''}>${label}${extra}</a>`;
  const badge = pendingCount ? `<span class="count" aria-label="${pendingCount} en attente">${pendingCount}</span>` : '';
  return page({
    title,
    body: `<div class="admin">
<header class="admin-top"><div class="wrap">
  ${brand('/admin')}
  <nav class="admin-nav" aria-label="Administration">
    ${link('/admin', 'dashboard', 'Tableau de bord')}
    ${link('/admin/users', 'users', 'Utilisateurs', badge)}
    ${link('/admin/activity', 'activity', 'Journal')}
  </nav>
  <form method="post" action="/admin/logout"><button type="submit" class="btn is-ghost is-small">${icon('logout')}Se déconnecter</button></form>
</div></header>
<main class="wrap">
${main}
</main>
</div>`,
  });
}

const pendingOf = (users: UserRecord[]) => users.filter((u) => u.status === 'pending');

export function renderAdminLogin(error?: string): string {
  return page({
    title: 'Admin',
    body: `<main class="flow"><div class="flow-inner">
${brand('/admin')}
<section class="panel" aria-labelledby="title">
  <h1 id="title">Administration</h1>
  <p>Valide les demandes d'accès et suis l'activité du serveur.</p>
  ${error ? `<div class="note is-error" role="alert">${icon('alert')}<p>${escapeHtml(error)}</p></div>` : ''}
  <form method="post" action="/admin/login">
    <div class="field">
      <label for="passphrase">Phrase secrète du serveur</label>
      <div class="password">
        <input class="input" id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
        <button type="button" class="reveal" data-reveal="passphrase" aria-pressed="false" hidden>Afficher</button>
      </div>
    </div>
    <button class="btn is-block" type="submit">Se connecter</button>
  </form>
</section>
</div></main>`,
  });
}

/* ---------- Small pieces ---------- */

function avatar(user: Pick<UserRecord, 'displayName' | 'userId'>, big = false): string {
  // A stable colour per person, from their id.
  const tint = parseInt(user.userId.slice(0, 2), 16) % 4 || 0;
  return `<span class="avatar is-${tint}${big ? ' is-big' : ''}" aria-hidden="true">${escapeHtml(initials(user.displayName))}</span>`;
}

function statusPill(user: UserRecord): string {
  if (user.isOwner) return '<span class="pill is-owner">propriétaire</span>';
  if (user.status === 'pending') return '<span class="pill is-pending">en attente</span>';
  return '<span class="pill is-ok">validé</span>';
}

/** Where an action sends the owner back to: only our own pages. */
export function safeBack(value: unknown): string {
  const back = String(value ?? '');
  return /^\/admin(\/users(\/[0-9a-f]{64})?)?$/.test(back) ? back : '/admin';
}

function actionForm(user: UserRecord, verb: 'approve' | 'reject' | 'revoke', back: string): string {
  const labels = { approve: 'Valider', reject: 'Refuser', revoke: "Retirer l'accès" };
  const question =
    verb === 'reject'
      ? `Refuser la demande de ${user.displayName} ?`
      : `Retirer l'accès de ${user.displayName} ? Sa session et son historique seront effacés.`;
  const confirm = verb === 'approve' ? '' : ` data-confirm="${escapeHtml(question)}"`;
  const style = verb === 'approve' ? 'btn is-small' : 'btn is-small is-danger';
  return `<form method="post" action="/admin/users/${escapeHtml(user.userId)}/${verb}"${confirm}><input type="hidden" name="back" value="${escapeHtml(back)}"><button type="submit" class="${style}">${labels[verb]}</button></form>`;
}

function actionsFor(user: UserRecord, back: string): string {
  if (user.isOwner) return '';
  return user.status === 'pending'
    ? actionForm(user, 'approve', back) + actionForm(user, 'reject', back)
    : actionForm(user, 'revoke', back);
}

function empty(glyph: IconName, title: string, text: string): string {
  return `<div class="empty">${icon(glyph)}<p><strong>${title}</strong></p><p>${text}</p></div>`;
}

function noOwnerBanner(users: UserRecord[]): string {
  return users.some((u) => u.isOwner)
    ? ''
    : `<div class="note is-error" role="alert">${icon('alert')}<p>Aucun propriétaire : définis OWNER_ED_USERNAME ou importe session.json.</p></div>`;
}

const EVENT_ICONS: Record<ActivityEvent['type'], { glyph: IconName; tone: string }> = {
  tool: { glyph: 'bolt', tone: '' },
  login: { glyph: 'key', tone: 'is-good' },
  login_failed: { glyph: 'x', tone: 'is-bad' },
  request: { glyph: 'plus', tone: 'is-new' },
  approved: { glyph: 'check', tone: 'is-good' },
  rejected: { glyph: 'x', tone: '' },
  revoked: { glyph: 'x', tone: '' },
  session_lost: { glyph: 'alert', tone: 'is-bad' },
};

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function describe(event: ActivityEvent, names: Map<string, string>): string {
  const who = event.userId ? `<strong>${escapeHtml(names.get(event.userId) ?? 'Compte supprimé')}</strong>` : '';
  switch (event.type) {
    case 'tool': {
      const failed = event.ok === false ? ' <span class="pill is-bad">échec</span>' : '';
      const ms = typeof event.ms === 'number' ? ` <span class="ms">${formatMs(event.ms)}</span>` : '';
      return `${who} ${escapeHtml(toolAction(event.tool))}${failed}${ms}`;
    }
    case 'login':
      return `${who} s'est connecté`;
    case 'login_failed':
      return who ? `Mot de passe incorrect pour ${who}` : 'Identifiants incorrects, compte inconnu';
    case 'request':
      return `${who} demande l'accès`;
    case 'approved':
      return `${who} a été validé`;
    case 'rejected':
      return 'Une demande a été refusée';
    case 'revoked':
      return 'Un accès a été retiré';
    case 'session_lost':
      return `La session École Directe de ${who} a expiré`;
  }
}

function feed(events: ActivityEvent[], names: Map<string, string>, now: number): string {
  return `<ul class="feed">${events
    .map((event) => {
      const { glyph, tone } = EVENT_ICONS[event.type];
      const ico = event.type === 'tool' && event.ok === false ? 'is-bad' : tone;
      return `<li><span class="ico ${ico}">${icon(glyph)}</span><span>${describe(event, names)}</span><time datetime="${escapeHtml(event.at)}">${relativeTime(event.at, now)}</time></li>`;
    })
    .join('')}</ul>`;
}

const nameMap = (users: UserRecord[]) => new Map(users.map((user) => [user.userId, user.displayName]));

/* ---------- The chart: tool calls per day, ok and failed stacked ---------- */

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) if (factor * step >= value) return factor * step;
  return 10 * step;
}

export function dailyChart(days: ReturnType<typeof dailyCalls>): string {
  const width = 640;
  const height = 210;
  const left = 34;
  const bottom = 24;
  const top = 8;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(...days.map((d) => d.ok + d.errors), 0));
  const slot = (width - left) / days.length;
  const barW = Math.min(24, slot * 0.62);
  const y = (value: number) => top + plotH - (value / max) * plotH;
  // A bar with a 4px rounded top and a square foot on the baseline.
  const bar = (x: number, y0: number, y1: number, cls: string, rounded: boolean) => {
    const h = y1 - y0;
    if (h <= 0) return '';
    const r = rounded ? Math.min(4, h, barW / 2) : 0;
    const head = r ? `V${y0 + r}Q${x},${y0} ${x + r},${y0}H${x + barW - r}Q${x + barW},${y0} ${x + barW},${y0 + r}` : `V${y0}H${x + barW}`;
    return `<path class="${cls}" d="M${x},${y1}${head}V${y1}Z"/>`;
  };
  const ticks = [0, max / 2, max]
    .map(
      (t) =>
        `<line class="grid-line" x1="${left}" x2="${width}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${left - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`,
    )
    .join('');
  const label = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  const bars = days
    .map((d, i) => {
      const x = left + i * slot + (slot - barW) / 2;
      const base = y(0);
      const okTop = y(d.ok);
      const total = d.ok + d.errors;
      const okBar = bar(x, okTop, base, 'bar-ok', d.errors === 0);
      // 2px of surface between the two segments.
      const errBar = d.errors ? bar(x, y(total), d.ok ? okTop - 2 : base, 'bar-err', true) : '';
      const showLabel = i % 2 === (days.length - 1) % 2;
      const tip = `${label(d.day)} : ${plural(total, 'appel')}${d.errors ? `, dont ${d.errors} en échec` : ''}`;
      return `<g class="day"><title>${tip}</title><rect class="bar-hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>${okBar}${errBar}${
        showLabel ? `<text class="axis" x="${x + barW / 2}" y="${height - 6}" text-anchor="middle">${label(d.day)}</text>` : ''
      }</g>`;
    })
    .join('');
  const table = `<table class="visually-hidden"><caption>Appels d'outils par jour</caption><thead><tr><th>Jour</th><th>Réussis</th><th>En échec</th></tr></thead><tbody>${days
    .map((d) => `<tr><td>${label(d.day)}</td><td>${d.ok}</td><td>${d.errors}</td></tr>`)
    .join('')}</tbody></table>`;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Appels d'outils par jour sur ${days.length} jours">${ticks}${bars}</svg>
<div class="legend"><span><i style="background:var(--electric)"></i>Réussis</span><span><i style="background:var(--tomato)"></i>En échec</span></div>${table}`;
}

function box(id: string, title: string, content: string, link = ''): string {
  return `<section class="box" aria-labelledby="${id}"><div class="box-head"><h2 id="${id}" style="font-size:1.2rem">${title}</h2>${link}</div>${content}</section>`;
}

/* ---------- Dashboard ---------- */

export interface DashboardData {
  users: UserRecord[];
  events: ActivityEvent[];
  now: number;
  health: HealthState | null;
  startedAt: number;
  readOnly: boolean;
}

const HEALTH_REASONS: Record<string, string> = {
  no_session: 'aucune session',
  auth_required: 'reconnexion nécessaire',
  school_unavailable: 'École Directe ne répond pas',
  error: 'erreur inattendue',
};

export function renderDashboard({ users, events, now, health, startedAt, readOnly }: DashboardData): string {
  const names = nameMap(users);
  const pending = pendingOf(users);
  const approved = users.filter((u) => u.status === 'approved');
  const stats = overview(events, now);
  const days = dailyCalls(events, now, 14);
  const tools = topTools(events, now).slice(0, 6);
  const errorRate = stats.calls7d ? Math.round((stats.errors7d / stats.calls7d) * 100) : 0;

  const tile = (label: string, value: string, hint: string, bad = false) =>
    `<div class="tile"><span class="label">${label}</span><span class="value">${value}</span><span class="hint${bad ? ' is-bad' : ''}">${hint}</span></div>`;

  const pendingBox = pending.length
    ? `<section class="box is-attention" aria-labelledby="pending-title" style="margin-bottom:1.2rem">
  <div class="box-head"><h2 id="pending-title" style="font-size:1.2rem">${pending.length === 1 ? 'Une demande attend ta réponse' : `${pending.length} demandes attendent ta réponse`}</h2></div>
  <ul class="people">${pending
    .map(
      (u) =>
        `<li>${avatar(u)}<div><a class="name" href="/admin/users/${escapeHtml(u.userId)}">${escapeHtml(u.displayName)}</a> ${statusPill(u)}<div class="meta">Demandé ${relativeTime(u.createdAt, now)}</div></div><div class="acts">${actionsFor(u, '/admin')}</div></li>`,
    )
    .join('')}</ul>
</section>`
    : '';

  const ownerState =
    !health || health.status === 'unknown'
      ? '<b>pas encore vérifiée</b>'
      : health.status === 'ok'
        ? '<b><span class="pill is-ok">OK</span></b>'
        : `<b><span class="pill is-bad">${escapeHtml(HEALTH_REASONS[health.reason ?? 'error'] ?? 'en panne')}</span></b>`;

  const chart = days.some((d) => d.ok + d.errors)
    ? dailyChart(days)
    : empty('bolt', "Aucun appel pour l'instant", "Le graphique se remplit dès que quelqu'un pose une question à son IA.");
  const ranking = tools.length
    ? `<ol class="rank">${tools
        .map(
          (t) =>
            `<li><span>${escapeHtml(toolLabel(t.tool))}</span><b>${t.count}</b><span class="meter"><i style="width:${Math.max(4, Math.round((t.count / tools[0].count) * 100))}%"></i></span></li>`,
        )
        .join('')}</ol>`
    : empty('grades', 'Rien cette semaine', 'Les outils les plus utilisés apparaîtront ici.');
  const recent = events.length
    ? feed([...events].reverse().slice(0, 8), names, now)
    : empty('clock', 'Journal vide', "Les connexions et les appels d'outils s'afficheront ici.");

  const main = `<div class="admin-head"><div><h1>Tableau de bord</h1><p>Ce qui s'est passé sur le serveur ces derniers jours.</p></div></div>
${noOwnerBanner(users)}
${pendingBox}
<div class="tiles">
  ${tile("Appels d'outils, 24 h", String(stats.calls24h), `${stats.calls7d} sur 7 jours`)}
  ${tile('Actifs cette semaine', String(stats.activeUsers7d), `sur ${plural(approved.length, 'compte')} ${approved.length > 1 ? 'validés' : 'validé'}`)}
  ${tile("Taux d'échec, 7 j", `${errorRate} %`, stats.errors7d ? `${plural(stats.errors7d, 'appel')} en échec` : 'aucun échec', errorRate >= 10)}
  ${tile('En attente', String(pending.length), pending.length ? 'à valider' : 'rien à faire')}
</div>
<div class="grid is-2" style="margin-bottom:1.2rem">
  ${box('chart-title', "Appels d'outils, 14 derniers jours", chart)}
  ${box('tools-title', 'Le plus demandé, 7 j', ranking)}
</div>
<div class="grid is-2">
  ${box('recent-title', 'Dernière activité', recent, '<a href="/admin/activity">Tout le journal</a>')}
  ${box(
    'health-title',
    'Santé du serveur',
    `<ul class="health">
      <li><span>Session du propriétaire</span>${ownerState}</li>
      <li><span>Dernière vérification</span><b>${health?.checkedAt ? relativeTime(health.checkedAt, now) : '—'}</b></li>
      <li><span>Serveur démarré</span><b>${relativeTime(new Date(startedAt).toISOString(), now)}</b></li>
      <li><span>Mode</span><b>${readOnly ? 'lecture seule' : 'lecture et écriture'}</b></li>
      <li><span>Comptes</span><b>${approved.length} ${approved.length > 1 ? 'validés' : 'validé'}, ${pending.length} en attente</b></li>
      <li><span>Journal</span><b>${plural(events.length, 'événement')} sur 30 jours</b></li>
    </ul>`,
  )}
</div>`;
  return shell('Tableau de bord', 'dashboard', pending.length, main);
}

/* ---------- People ---------- */

export function renderUsers(users: UserRecord[], events: ActivityEvent[], now: number): string {
  const usage = perUser(events, now);
  // Pending first: that is what the owner came for, then the most active.
  const sorted = [...users].sort(
    (a, b) =>
      Number(b.status === 'pending') - Number(a.status === 'pending') ||
      (usage.get(b.userId)?.calls7d ?? 0) - (usage.get(a.userId)?.calls7d ?? 0) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  const rows = sorted
    .map((u) => {
      const use = usage.get(u.userId);
      const meta =
        u.status === 'pending'
          ? `Demandé ${relativeTime(u.createdAt, now)}`
          : `${plural(use?.calls7d ?? 0, 'appel')} cette semaine, vu ${relativeTime(use?.lastAt ?? u.session?.updatedAt, now)}`;
      return `<li>${avatar(u)}<div><a class="name" href="/admin/users/${escapeHtml(u.userId)}">${escapeHtml(u.displayName)}</a> ${statusPill(u)}<div class="meta">${meta}</div></div><div class="acts">${actionsFor(u, '/admin/users')}</div></li>`;
    })
    .join('');
  const main = `<div class="admin-head"><div><h1>Utilisateurs</h1><p>${plural(users.length, 'compte')}. Pour inviter quelqu'un, envoie-lui le lien de la <a href="/">page d'accueil</a> : elle contient le tuto.</p></div></div>
${noOwnerBanner(users)}
<section class="box">${rows ? `<ul class="people">${rows}</ul>` : empty('user', "Personne pour l'instant", "Envoie le lien de la page d'accueil à un ami : sa demande apparaîtra ici.")}</section>`;
  return shell('Utilisateurs', 'users', pendingOf(users).length, main);
}

export function renderUserDetail(user: UserRecord, users: UserRecord[], events: ActivityEvent[], now: number): string {
  const mine = events.filter((e) => e.userId === user.userId);
  const stats = overview(mine, now);
  const days = dailyCalls(mine, now, 14);
  const tools = topTools(mine, now).slice(0, 5);
  const tile = (label: string, value: string) => `<div class="tile"><span class="label">${label}</span><span class="value">${value}</span></div>`;
  const main = `<a class="back" href="/admin/users">${icon('back')}Tous les utilisateurs</a>
<div class="admin-head"><div class="profile">${avatar(user, true)}<div><h1>${escapeHtml(user.displayName)}</h1><p>${statusPill(user)}</p></div></div><div class="people"><div class="acts">${actionsFor(user, `/admin/users/${user.userId}`)}</div></div></div>
<div class="tiles">
  ${tile('Appels, 24 h', String(stats.calls24h))}
  ${tile('Appels, 7 j', String(stats.calls7d))}
  ${tile('Échecs, 7 j', String(stats.errors7d))}
  ${tile('Dernière activité', `<span style="font-size:1.25rem">${relativeTime(mine.at(-1)?.at, now)}</span>`)}
</div>
<div class="grid is-2" style="margin-bottom:1.2rem">
  ${box('chart-title', "Appels d'outils, 14 jours", days.some((d) => d.ok + d.errors) ? dailyChart(days) : empty('bolt', 'Aucun appel', 'Pas encore de question posée sur ces 14 jours.'))}
  ${box(
    'facts-title',
    'Compte',
    `<dl class="facts">
      <dt>Type</dt><dd>${user.accountKind === 'E' ? 'Élève' : escapeHtml(user.accountKind)}</dd>
      <dt>Demandé</dt><dd>${relativeTime(user.createdAt, now)}</dd>
      <dt>Validé</dt><dd>${user.approvedAt ? relativeTime(user.approvedAt, now) : '—'}</dd>
      <dt>Session ED</dt><dd>${user.session ? `renouvelée ${relativeTime(user.session.updatedAt, now)}` : 'aucune'}</dd>
      <dt>Outils favoris</dt><dd>${tools.length ? tools.map((t) => `${escapeHtml(toolLabel(t.tool))} (${t.count})`).join(', ') : '—'}</dd>
    </dl>`,
  )}
</div>
${box(
  'recent-title',
  'Son activité',
  mine.length ? feed([...mine].reverse().slice(0, 15), nameMap(users), now) : empty('clock', 'Rien pour le moment', 'Ses connexions et ses questions apparaîtront ici.'),
  `<a href="/admin/activity?user=${escapeHtml(user.userId)}">Dans le journal</a>`,
)}`;
  return shell(user.displayName, 'users', pendingOf(users).length, main);
}

/* ---------- Journal ---------- */

export const JOURNAL_FILTERS = {
  all: 'Tout',
  tool: "Appels d'outils",
  errors: 'Échecs',
  access: 'Connexions et accès',
} as const;

export type JournalFilter = keyof typeof JOURNAL_FILTERS;

export function parseJournalFilter(value: unknown): JournalFilter {
  return typeof value === 'string' && value in JOURNAL_FILTERS ? (value as JournalFilter) : 'all';
}

export function filterEvents(events: ActivityEvent[], kind: JournalFilter, userId: string): ActivityEvent[] {
  return events.filter((e) => {
    if (userId && e.userId !== userId) return false;
    if (kind === 'tool') return e.type === 'tool';
    if (kind === 'errors') return (e.type === 'tool' && e.ok === false) || e.type === 'login_failed' || e.type === 'session_lost';
    if (kind === 'access') return e.type !== 'tool';
    return true;
  });
}

const JOURNAL_LIMIT = 200;

export function renderJournal(users: UserRecord[], events: ActivityEvent[], now: number, kind: JournalFilter, userId: string): string {
  const shown = filterEvents(events, kind, userId).reverse();
  const options = (entries: Array<[string, string]>, selected: string) =>
    entries
      .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('');
  const people: Array<[string, string]> = [['', 'Tout le monde'], ...users.map((u): [string, string] => [u.userId, u.displayName])];
  const list = shown.length
    ? `${feed(shown.slice(0, JOURNAL_LIMIT), nameMap(users), now)}${
        shown.length > JOURNAL_LIMIT ? `<p class="muted small" style="margin-top:1rem">Les ${JOURNAL_LIMIT} plus récents sur ${shown.length}.</p>` : ''
      }`
    : empty(
        'clock',
        'Rien à afficher',
        kind === 'all' && !userId ? 'Le journal se remplit au fil des connexions et des questions.' : 'Aucun événement ne correspond à ces filtres.',
      );
  const main = `<div class="admin-head"><div><h1>Journal</h1><p>Les 30 derniers jours. Des faits seulement, jamais le contenu des questions ni des réponses.</p></div></div>
<form class="filters" method="get" action="/admin/activity">
  <label>Événements<select class="select" name="kind" data-autosubmit>${options(Object.entries(JOURNAL_FILTERS), kind)}</select></label>
  <label>Personne<select class="select" name="user" data-autosubmit>${options(people, userId)}</select></label>
  <noscript><button class="btn is-small" type="submit">Filtrer</button></noscript>
</form>
<section class="box">${list}</section>`;
  return shell('Journal', 'activity', pendingOf(users).length, main);
}
