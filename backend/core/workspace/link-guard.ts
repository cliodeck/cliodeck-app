/**
 * `.cliodeck`, ou l'un de ses fichiers, lié hors du projet (D18) : rien ne s'ouvre à travers le
 * lien, ni en lecture ni en écriture, et rien n'est créé à sa place. Un `brain.db` lié vers celui
 * d'un autre projet en recevait toutes les tables, et ses extraits y restaient (mesuré en phase 1).
 *
 * La garde vit ici, en amont de `layout.ts` : elle passe avant la migration et avant tout service
 * qui ouvre une base, un index ou un journal. Les deux côtés sont comparés par chemins réels
 * (`isInside`) : une racine ouverte par un lien (`/tmp`, un dossier déplacé) ne refuse rien à tort.
 *
 * Limites connues, assumées : un lien dont la cible passe par `/System/Volumes/Data/…` est vu
 * dehors (`realpath` garde ce préfixe) ; un lien dur ne se voit pas ; une boucle de liens compte
 * comme dehors. Un lien cassé qui reste dans le projet n'est pas affaire de cette garde :
 * `config.ts` le dit illisible.
 */
import { lstatSync } from 'fs';
import { lstat } from 'fs/promises';
import path from 'path';
import { isInside, isInsideAsync } from '../vector-store/file-identity.js';
import { workspaceFiles } from './layout.js';

/** Ce qu'ouvrent les services : bases (avec leurs `-wal` / `-shm`), index, journaux, recettes. */
const GUARDED_ENTRIES = [
  'config.json',
  'brain.db',
  'brain.db-wal',
  'brain.db-shm',
  'journal.db',
  'journal.db-wal',
  'journal.db-shm',
  'hnsw.index',
  'primary-hnsw.index',
  'mcp-access.jsonl',
  'security-events.jsonl',
  'recipes',
  'recipes-runs',
];

/** `.cliodeck` d'abord : lié dehors, tout ce qu'il contient l'est aussi, et c'est lui qu'il faut nommer. */
function guardedPaths(workspaceRoot: string): string[] {
  const dir = workspaceFiles(workspaceRoot).root;
  return [dir, ...GUARDED_ENTRIES.map((name) => path.join(dir, name))];
}

/**
 * Le premier chemin de l'espace de travail qui mène hors du projet, ou `null`. Seul ce qui est là
 * compte (`lstat`, lien cassé compris) : un fichier absent n'a rien à refuser.
 */
export async function workspaceLinkOutside(workspaceRoot: string): Promise<string | null> {
  for (const entry of guardedPaths(workspaceRoot)) {
    const present = await lstat(entry).then(
      () => true,
      () => false
    );
    if (present && !(await isInsideAsync(workspaceRoot, entry))) return entry;
  }
  return null;
}

/** Le même verdict, pour qui ouvre une base dans un chemin synchrone. */
export function workspaceLinkOutsideSync(workspaceRoot: string): string | null {
  for (const entry of guardedPaths(workspaceRoot)) {
    let present = true;
    try {
      lstatSync(entry);
    } catch {
      present = false;
    }
    if (present && !isInside(workspaceRoot, entry)) return entry;
  }
  return null;
}

/**
 * Le motif, lisible par un historien : quel fichier, ce qui n'a pas été fait, quoi faire. Le
 * chemin est dit relatif au projet, sauf s'il ne s'y rattache pas.
 */
export function workspaceLinkOutsideMessage(workspaceRoot: string, entry: string): string {
  const relative = path.relative(workspaceRoot, entry);
  const shown = relative && !relative.startsWith('..') ? relative : entry;
  return (
    `${shown} est un lien qui mène hors du projet : ClioDeck ne l'ouvre pas et n'y écrit rien, ` +
    `il n'a pas été modifié. Remettez le dossier .cliodeck dans le projet, à la place du lien, ` +
    `puis rouvrez le projet.`
  );
}
