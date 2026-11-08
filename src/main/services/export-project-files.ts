/**
 * Bibliographie et style CSL du projet, tels que l'export les lit côté main.
 *
 * Le renderer transmet ceux de `currentProject`, posés à l'ouverture du projet
 * et jamais relus : un `.bib` importé ou synchronisé pendant la séance lui
 * restait inconnu, et un style déclaré mais absent gardait son chemin relatif,
 * que personne ne rapportait au projet (BT1-4).
 *
 * Tout passe par des lectures asynchrones : un disque qui ne répond plus fait
 * échoir la limite de l'export au lieu de geler le processus principal.
 */
import { readFile } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import { parseUserJson } from '../../../backend/core/fs/user-files.js';
import { pathExists } from './export-time-limit.js';

/**
 * La bibliographie que déclare `project.json`, relu au moment de l'export
 * (comme le fait `bibliography:import`). Celle du renderer n'est plus qu'un
 * repli : `project.json` illisible, ou ancien champ `bibliography` sans
 * `bibliographySource`.
 */
export async function resolveProjectBibliography(
  projectPath: string,
  fromRenderer?: string
): Promise<string | undefined> {
  try {
    const manifest = parseUserJson<{ bibliographySource?: { filePath?: string } } | null>(
      await readFile(join(projectPath, 'project.json'), 'utf-8')
    );
    const declared = manifest?.bibliographySource?.filePath;
    if (declared) {
      const bibPath = resolve(projectPath, declared);
      if (await pathExists(bibPath)) return bibPath;
    }
  } catch {
    // Pas de project.json lisible : ce que transmet le renderer.
  }
  return fromRenderer;
}

/**
 * Le style CSL du projet en absolu, s'il existe ; sinon le chemin introuvable,
 * que l'export doit dire au lieu d'écarter le style en silence.
 * `project.json` l'enregistre relatif au projet, et l'ouverture ne le rend
 * absolu que si le fichier est là.
 */
export async function resolveProjectCsl(
  projectPath: string,
  cslPath?: string
): Promise<{ path?: string; missing?: string }> {
  if (!cslPath) return {};
  const absolute = isAbsolute(cslPath) ? cslPath : join(projectPath, cslPath);
  return (await pathExists(absolute)) ? { path: absolute } : { missing: absolute };
}
