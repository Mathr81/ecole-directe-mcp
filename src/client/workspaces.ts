/**
 * Espaces de travail (class workspaces) and the files in their cloud, over
 * direct HTTP. Checked against the live API:
 *
 *  - `/v3/E/{id}/espacestravail.awp` lists every workspace the student can
 *    see, joined or not; `titre` is plain text, `resume` is base64.
 *  - `/v3/cloud/W/{workspaceId}.awp` returns the root folder, a few levels
 *    deep. Deeper folders come back with `isLoaded: false`; they are fetched
 *    with `idFolder` = their path relative to the workspace root, leading
 *    backslash included (`\METHODOLOGIE\Dissertation`). Without that leading
 *    backslash École Directe answers an empty phantom folder, not an error.
 *  - Files download through telechargement.awp with `leTypeDeFichier=CLOUD`,
 *    but a workspace file answers 403 unless the body also names the
 *    workspace (`idEntity`, `typeEntity: "W"`) — see download.ts.
 */
import { decodeMaybeBase64 } from './base64.js';
import { post } from './edHttp.js';
import { PossiblyExpiredSessionError } from './errors.js';
import type { Session, Workspace, WorkspaceEntry } from './types.js';

interface RawWorkspace {
  id: number;
  titre?: string;
  resume?: string;
  estMembre?: boolean;
  cloud?: boolean;
  creePar?: string;
}

interface RawCloudNode {
  type: string;
  libelle: string;
  date?: string;
  taille?: number;
  id: string;
  isLoaded?: boolean;
  children?: RawCloudNode[];
}

export async function fetchWorkspaces(session: Session): Promise<Workspace[]> {
  const data = await post(session, `/v3/E/${session.accountId}/espacestravail.awp?verbe=get`, {});
  if (!Array.isArray(data)) {
    throw new PossiblyExpiredSessionError(
      "École Directe n'a renvoyé aucune liste d'espaces de travail — session probablement expirée.",
    );
  }
  return (data as RawWorkspace[]).map((w) => ({
    id: w.id,
    title: w.titre ?? '',
    summary: decodeMaybeBase64(w.resume),
    member: w.estMembre === true,
    hasFiles: w.cloud === true,
    createdBy: w.creePar ?? '',
  }));
}

/** `\RNE\W\789\METHODOLOGIE` → `\METHODOLOGIE`; the root becomes "". */
export function relativeFolder(nodeId: string, workspaceId: number): string {
  const marker = `\\W\\${workspaceId}`;
  const at = nodeId.indexOf(marker);
  return at === -1 ? nodeId : nodeId.slice(at + marker.length);
}

export function flattenCloud(root: RawCloudNode, workspaceId: number): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const walk = (folder: RawCloudNode) => {
    const parent = relativeFolder(folder.id, workspaceId);
    for (const node of folder.children ?? []) {
      if (node.type === 'folder') {
        const loaded = node.isLoaded !== false;
        entries.push({ type: 'folder', name: node.libelle, folder: relativeFolder(node.id, workspaceId), parent, date: node.date ?? null, sizeBytes: node.taille ?? 0, contentsListed: loaded });
        if (loaded) walk(node);
      } else if (node.type === 'file') {
        entries.push({ type: 'file', name: node.libelle, fileId: node.id, parent, date: node.date ?? null, sizeBytes: node.taille ?? 0 });
      }
    }
  };
  walk(root);
  return entries;
}

export async function fetchWorkspaceFiles(session: Session, workspaceId: number, folder?: string): Promise<WorkspaceEntry[]> {
  const query = new URLSearchParams({ verbe: 'get' });
  if (folder) query.set('idFolder', folder.startsWith('\\') ? folder : `\\${folder}`);
  const data = await post(session, `/v3/cloud/W/${workspaceId}.awp?${query}`, {});
  const root = Array.isArray(data) ? (data[0] as RawCloudNode | undefined) : undefined;
  if (!root) {
    throw new PossiblyExpiredSessionError(
      `École Directe n'a renvoyé aucun contenu pour l'espace de travail ${workspaceId} — session probablement expirée.`,
    );
  }
  return flattenCloud(root, workspaceId);
}
