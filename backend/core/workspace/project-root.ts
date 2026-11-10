/**
 * Le dossier d'un projet ouvert a disparu (parent renommé, volume débranché) : aucun écrivain ne le
 * recrée. Un `mkdir` récursif le faisait renaître, vide, à son ancien chemin, avec la seule note ou
 * le seul fichier qu'on venait d'écrire, loin du vrai projet (L03-3).
 *
 * Le refus porte un code, que l'IPC renvoie et que l'interface traduit (`project.rootMissing`) :
 * jamais un texte brut. Rien n'est écrit.
 */
import { statSync } from 'fs';
import { stat } from 'fs/promises';

export class ProjectRootMissingError extends Error {
  readonly code = 'project_root_missing' as const;
  readonly root: string;

  constructor(root: string) {
    super('project_root_missing');
    this.name = 'ProjectRootMissingError';
    this.root = root;
  }
}

/** Le chemin n'existe plus, ou un de ses parents n'est plus un dossier. Toute autre erreur remonte. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Lève `ProjectRootMissingError` si `root` n'est plus un dossier. */
export async function assertProjectRoot(root: string): Promise<void> {
  try {
    if ((await stat(root)).isDirectory()) return;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  throw new ProjectRootMissingError(root);
}

/** La même garde, pour un écrivain synchrone. */
export function assertProjectRootSync(root: string): void {
  try {
    if (statSync(root).isDirectory()) return;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  throw new ProjectRootMissingError(root);
}
