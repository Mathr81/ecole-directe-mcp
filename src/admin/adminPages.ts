import type { UserRecord } from '../store/userStore.js';
import { escapeHtml, renderShell } from '../oauth/pages.js';

export function renderAdminLogin(error?: string): string {
  return renderShell(
    'Admin',
    `<h1>Administration</h1>
  <p>Valide ou refuse les demandes d'accès à ce serveur.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/admin/login">
    <label for="passphrase">Phrase secrète du serveur</label>
    <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Se connecter</button>
  </form>`,
  );
}

function when(iso: string | undefined): string {
  return iso ? escapeHtml(iso.slice(0, 16).replace('T', ' ')) : '—';
}

function action(userId: string, verb: 'approve' | 'reject' | 'revoke', label: string, secondary = false): string {
  return `<form method="post" action="/admin/users/${escapeHtml(userId)}/${verb}"><button type="submit"${secondary ? ' class="secondary"' : ''}>${label}</button></form>`;
}

function row(user: UserRecord): string {
  const status = user.isOwner ? 'propriétaire' : user.status === 'pending' ? 'en attente' : 'validé';
  const actions = user.isOwner
    ? ''
    : user.status === 'pending'
      ? action(user.userId, 'approve', 'Valider') + action(user.userId, 'reject', 'Refuser', true)
      : action(user.userId, 'revoke', 'Révoquer', true);
  return `<tr>
      <td>${escapeHtml(user.displayName)}</td>
      <td>${user.accountKind === 'E' ? 'élève' : escapeHtml(user.accountKind)}</td>
      <td>${status}</td>
      <td>${when(user.createdAt)}</td>
      <td>${when(user.session?.updatedAt)}</td>
      <td>${actions}</td>
    </tr>`;
}

export function renderAdminList(users: UserRecord[], hasOwner: boolean): string {
  // Pending first: that is what the owner came for.
  const sorted = [...users].sort(
    (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || a.createdAt.localeCompare(b.createdAt),
  );
  return renderShell(
    'Admin',
    `<h1>Utilisateurs</h1>
  ${hasOwner ? '' : '<p class="error">Aucun propriétaire : définis OWNER_ED_USERNAME ou importe session.json.</p>'}
  <table>
    <thead><tr><th>Nom</th><th>Type de compte</th><th>Statut</th><th>Demandé le</th><th>Dernière session</th><th></th></tr></thead>
    <tbody>
    ${sorted.map(row).join('\n    ') || '<tr><td colspan="6">Personne pour l\'instant.</td></tr>'}
    </tbody>
  </table>
  <form method="post" action="/admin/logout"><button type="submit" class="secondary">Se déconnecter</button></form>`,
    { wide: true },
  );
}
