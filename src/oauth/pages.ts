export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pages of the login flow and of the admin, sharing one stylesheet.
 *
 * Self-contained on purpose: no external stylesheet, script or font, so the
 * pages work with any content-security policy and leak nothing to a CDN.
 * Every value interpolated below that is not a constant goes through
 * `escapeHtml` — client names and display names are untrusted.
 */
export function renderShell(title: string, body: string, options: { wide?: boolean } = {}): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — École Directe MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f7; --fg:#1a1a1a; --muted:#5c5c5c; --card:#fff; --line:#e0e0e2; --accent:#2f6feb; --err:#b3261e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#17171a; --fg:#ececee; --muted:#a0a0a6; --card:#212125; --line:#34343a; --accent:#6b9bff; --err:#f2b8b5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { width:100%; max-width:26rem; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { margin:0 0 6px; font-size:1.15rem; }
  p { margin:0 0 18px; color:var(--muted); font-size:.925rem; }
  strong { color:var(--fg); }
  label { display:block; font-size:.875rem; font-weight:600; margin-bottom:6px; }
  input { width:100%; padding:11px 12px; font-size:1rem; border-radius:9px; border:1px solid var(--line);
          background:var(--bg); color:var(--fg); }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:16px; padding:11px 12px; font-size:1rem; font-weight:600; border:0;
           border-radius:9px; background:var(--accent); color:#fff; cursor:pointer; }
  .error { margin:0 0 16px; padding:10px 12px; border-radius:9px; font-size:.875rem;
           background:color-mix(in srgb, var(--err) 14%, transparent); color:var(--err); }
  ul { margin:0 0 18px; padding-left:1.1rem; color:var(--muted); font-size:.875rem; }
  label + input { margin-bottom:12px; }
  .choice { display:flex; gap:10px; align-items:center; font-weight:400; padding:10px 12px; margin:0 0 8px;
            border:1px solid var(--line); border-radius:9px; cursor:pointer; }
  .choice input { width:auto; margin:0; }
  .notice { font-size:.8rem; margin:16px 0 0; }
  table { width:100%; border-collapse:collapse; font-size:.875rem; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  td form { display:inline; }
  td button { width:auto; margin:0 4px 4px 0; padding:6px 10px; font-size:.8rem; }
  button.secondary { background:transparent; color:var(--fg); border:1px solid var(--line); }
  main.wide { max-width:52rem; }
</style>
</head>
<body>
<main${options.wide ? ' class="wide"' : ''}>
${body}
</main>
</body>
</html>`;
}

function errorBlock(error?: string): string {
  return error ? `<p class="error">${escapeHtml(error)}</p>` : '';
}

export interface LoginPageOptions {
  pendingId: string;
  /** As the client registered itself — untrusted. */
  clientName: string;
  action: string;
  error?: string;
}

export function renderLoginPage({ pendingId, clientName, action, error }: LoginPageOptions): string {
  return renderShell(
    'Connexion',
    `<h1>Connexion à École Directe</h1>
  <p><strong>${escapeHtml(clientName)}</strong> demande à lire tes données École Directe via ce serveur.</p>
  <ul>
    <li>Notes, devoirs, emploi du temps, vie scolaire</li>
    <li>Messagerie : lecture seule</li>
  </ul>
  ${errorBlock(error)}
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <label for="username">Identifiant École Directe</label>
    <input id="username" name="username" autocomplete="username" autocapitalize="none" autofocus required>
    <label for="password">Mot de passe</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Se connecter</button>
  </form>
  <p class="notice">Ce serveur garde ta session École Directe chiffrée, jamais ton mot de passe. Tes données passent par l'IA que tu connectes. Le propriétaire du serveur gère les accès : demande-lui pour être supprimé.</p>`,
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
    .join('\n    ');
  return renderShell(
    'Question de sécurité',
    `<h1>Question de sécurité École Directe</h1>
  <p>${escapeHtml(question)}</p>
  ${errorBlock(error)}
  <form method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    ${choices}
    <button type="submit">Valider</button>
  </form>`,
  );
}

export function renderMessagePage({ title, message }: { title: string; message: string }): string {
  return renderShell(title, `<h1>${escapeHtml(title)}</h1>\n  <p>${escapeHtml(message)}</p>`);
}
