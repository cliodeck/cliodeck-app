/**
 * Bibliographie, style CSL et dossiers d'images du projet, tels que l'export les lit côté main.
 *
 * Le renderer transmet ceux de `currentProject`, posés à l'ouverture du projet
 * et jamais relus : un `.bib` importé ou synchronisé pendant la séance lui
 * restait inconnu, et un style déclaré mais absent gardait son chemin relatif,
 * que personne ne rapportait au projet (BT1-4).
 *
 * Tout passe par des lectures asynchrones : un disque qui ne répond plus fait
 * échoir la limite de l'export au lieu de geler le processus principal.
 */
import { lstat, readFile, symlink, unlink } from 'fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'path';
import { parseUserJson } from '../../../backend/core/fs/user-files.js';
import type { OutcomeIssue } from '../../../backend/types/outcome.js';
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

/** Crée le lien `path` vers le dossier `target` (une jonction sous Windows, sans droits d'admin). */
export type LinkDirectory = (target: string, path: string) => Promise<void>;

const linkDirectory: LinkDirectory = (target, path) => symlink(target, path, 'junction');

/**
 * Les dossiers où pandoc cherche les images du projet (`projectResourcePaths`), tels qu'il peut
 * les lire dans `--resource-path`. Pandoc découpe cette liste sur `path.delimiter` (`:` sous macOS
 * et Linux, `;` sous Windows) : un projet nommé « Les archives : une histoire » y devenait deux
 * dossiers inexistants, et ses images disparaissaient de l'export PDF ou Word (S12-1-1). La
 * création d'un projet n'interdit que `/` et `\`, et un titre porte souvent « : ».
 *
 * Un tel dossier passe par un lien (`res-0`, `res-1`…) créé dans le dossier de travail de
 * l'export, où pandoc tourne : pandoc reçoit ce nom relatif. Les autres passent tels quels. Les
 * liens (`links`) se retirent par `removeResourceLinks` avant que le dossier de travail parte.
 *
 * Un lien qui ne se crée pas (sous Windows, une jonction ne mène pas à un volume réseau) : le
 * dossier est écarté, et la réserve `export.imageFolderUnreachable` dit pourquoi ses images
 * manquent, au lieu de laisser pandoc chercher dans deux moitiés de chemin.
 */
export async function stageResourcePaths(
  dirs: readonly string[],
  workDir: string,
  link: LinkDirectory = linkDirectory
): Promise<{ paths: string[]; links: string[]; warnings: OutcomeIssue[] }> {
  const paths: string[] = [];
  const links: string[] = [];
  const warnings: OutcomeIssue[] = [];
  for (const [i, dir] of dirs.entries()) {
    if (!dir.includes(delimiter)) {
      paths.push(dir);
      continue;
    }
    const name = `res-${i}`;
    const linkPath = join(workDir, name);
    try {
      await link(resolve(dir), linkPath);
      links.push(linkPath);
      paths.push(name);
    } catch (err) {
      console.warn('⚠️ export: dossier d’images inaccessible à pandoc, écarté :', dir, err);
      warnings.push({ code: 'export.imageFolderUnreachable', params: { dir, char: delimiter } });
    }
  }
  return { paths, links, warnings };
}

/**
 * Retire les liens de `stageResourcePaths`, avant que le dossier de travail de l'export parte :
 * une suppression récursive ne doit jamais pouvoir passer par eux dans le projet. Seul un lien
 * est retiré ; un lien déjà parti ne compte pas. Rend faux si l'un d'eux reste, ou si un chemin
 * donné n'est pas un lien : le dossier de travail est alors laissé en place (créé par `mkdtemp`,
 * lisible du seul compte de l'auteur) plutôt que de risquer le projet.
 */
export async function removeResourceLinks(links: readonly string[]): Promise<boolean> {
  let removed = true;
  for (const link of links) {
    try {
      if (!(await lstat(link)).isSymbolicLink()) {
        console.warn('⚠️ export: pas un lien, laissé en place avec le dossier de travail :', link);
        removed = false;
        continue;
      }
      await unlink(link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.warn('⚠️ export: lien vers le projet non retiré, dossier de travail laissé en place :', link, err);
      removed = false;
    }
  }
  return removed;
}
