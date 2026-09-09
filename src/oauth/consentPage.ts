function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ConsentPageOptions {
  /** Opaque id of the pending authorization request. */
  pendingId: string;
  /** Client name as it registered itself — untrusted, so it is escaped. */
  clientName: string;
  consentPath: string;
  error?: string;
}

/**
 * The consent screen. Anthropic requires every connection to go through user
 * consent — a machine-to-machine grant with no human in the loop is not
 * supported — and on a personal single-account server "consent" and
 * "authentication" are the same step: prove you are the owner, by passphrase.
 *
 * Self-contained on purpose: no external stylesheet, script or font, so the
 * page works with any content-security policy and leaks nothing to a CDN.
 */
export function renderConsentPage({ pendingId, clientName, consentPath, error }: ConsentPageOptions): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser l'accès — École Directe MCP</title>
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
</style>
</head>
<body>
<main>
  <h1>Autoriser l'accès à École Directe</h1>
  <p><strong>${escapeHtml(clientName)}</strong> demande à lire tes données École Directe via ce serveur.</p>
  <ul>
    <li>Notes, devoirs, emploi du temps, vie scolaire</li>
    <li>Messagerie : lecture seule</li>
  </ul>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="${escapeHtml(consentPath)}">
    <input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
    <label for="passphrase">Phrase secrète du serveur</label>
    <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Autoriser</button>
  </form>
</main>
</body>
</html>`;
}
