/**
 * Identité d'un fichier indexé : « un fichier, un document » (rc.5) veut dire
 * un fichier **sur le disque**, pas une chaîne de caractères.
 *
 * Le dédoublonnage comparait les chemins comme des chaînes. Or macOS (APFS par
 * défaut) ne distingue ni la casse ni la forme Unicode : `…ETHICS….pdf` et
 * `…Ethics….pdf` désignent le même fichier. Un PDF renommé en ne changeant
 * que la casse — renommage Zotero d'une pièce jointe —, puis réindexé,
 * devenait un second document, ses extraits en double (#123, mesuré sur un
 * projet réel). Un lien symbolique produisait le même effet.
 *
 * L'identité est donc le chemin **réel** (`realpath` natif : liens résolus,
 * casse telle qu'enregistrée sur le disque). Un fichier disparu n'en a plus :
 * on retombe sur la chaîne, sans rien supposer.
 */

import { readlinkSync, realpathSync } from 'fs';
import { readlink, realpath as realpathAsync } from 'fs/promises';
import path from 'path';

export type RealpathFn = (filePath: string) => string;

/** Au-delà, c'est une boucle de liens : le même plafond que `resolveTarget` (`user-files.ts`). */
const MAX_LINK_HOPS = 40;

/** Chemin réel du fichier, ou le chemin tel quel s'il n'existe pas. */
export function fileIdentity(filePath: string, realpath: RealpathFn = realpathSync.native): string {
  try {
    return realpath(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Deux chemins peuvent-ils désigner le même fichier ? Filtre bon marché, sans
 * appel système, avant de comparer les chemins réels : même nom de fichier à
 * la casse et à la forme Unicode près. Faux négatif possible seulement pour
 * deux liens de noms différents vers un même fichier, que l'indexation ne
 * produit pas.
 */
export function mayBeSameFile(a: string, b: string): boolean {
  const fold = (p: string) => (p.split(/[\\/]/).pop() ?? p).normalize('NFC').toLowerCase();
  return fold(a) === fold(b);
}

/**
 * Regroupe des lignes par fichier réel, dans l'ordre reçu. Seuls les groupes
 * de plus d'une ligne sont des doublons.
 */
export function groupByFile<T extends { file_path: string }>(
  rows: readonly T[],
  realpath: RealpathFn = realpathSync.native
): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = fileIdentity(row.file_path, realpath);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/** Un chemin de Windows s'analyse comme tel sur tout système, jusque dans les tests. */
function pathApi(filePath: string): path.PlatformPath {
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(filePath) ? path.win32 : path;
}

/** Ce que le parcours d'un chemin demande au disque. */
interface DiskQuestion {
  ask: 'realpath' | 'readlink';
  target: string;
}

/**
 * Le parcours d'un chemin, sans aucun appel au disque : il pose ses questions, et reçoit
 * `null` pour un échec. Les deux versions, synchrone et asynchrone, y répondent : ce qu'un
 * lien a le droit d'atteindre ne doit pas dépendre de la façon de le demander.
 */
function* walkToRealLocation(filePath: string): Generator<DiskQuestion, string | null, string | null> {
  const api = pathApi(filePath);
  const missingPart: string[] = [];
  let current = api.resolve(filePath);
  let hops = 0;
  while (hops < MAX_LINK_HOPS) {
    const real = yield { ask: 'realpath', target: current };
    if (real !== null) return api.join(real, ...missingPart);

    // Absent, ou lien cassé : on regarde lequel.
    const link = yield { ask: 'readlink', target: current };
    if (link !== null) {
      // Depuis le dossier réel du lien, comme le système : le `..` d'une cible
      // relative ne remonte pas par le dossier lien qui a pu mener jusqu'ici.
      const dir = api.dirname(current);
      const realDir = yield { ask: 'realpath', target: dir };
      current = api.resolve(realDir ?? dir, link);
      hops += 1;
      continue;
    }
    const parent = api.dirname(current);
    if (parent === current) return api.join(current, ...missingPart);
    missingPart.unshift(api.basename(current));
    current = parent;
  }
  return null;
}

/**
 * Où mène ce chemin sur le disque : liens suivis, lien cassé compris (`realpath`
 * échoue sur lui, alors qu'une écriture le suivrait), et ce qui n'existe pas encore
 * laissé tel quel derrière le dernier dossier réel. `null` pour une boucle de liens,
 * qui ne mène nulle part.
 */
export function realLocation(
  filePath: string,
  realpath: RealpathFn = realpathSync.native
): string | null {
  const walk = walkToRealLocation(filePath);
  let step = walk.next();
  while (step.done !== true) {
    const { ask, target } = step.value;
    let answer: string | null = null;
    try {
      answer = ask === 'realpath' ? realpath(target) : readlinkSync(target);
    } catch {
      // Le parcours sait quoi faire d'un échec.
    }
    step = walk.next(answer);
  }
  return step.value;
}

async function realLocationAsync(filePath: string): Promise<string | null> {
  const walk = walkToRealLocation(filePath);
  let step = walk.next();
  while (step.done !== true) {
    const { ask, target } = step.value;
    let answer: string | null = null;
    try {
      answer = await (ask === 'realpath' ? realpathAsync(target) : readlink(target));
    } catch {
      // Le parcours sait quoi faire d'un échec.
    }
    step = walk.next(answer);
  }
  return step.value;
}

/**
 * Ces deux chemins désignent-ils le même fichier ? Le disque tranche la casse et les
 * liens ; pour ce qui n'existe pas encore, seule la forme Unicode est pardonnée (et la
 * casse sous Windows, qui ne la distingue jamais).
 */
export function sameFile(
  a: string,
  b: string,
  realpath: RealpathFn = realpathSync.native
): boolean {
  const key = (filePath: string): string => {
    const api = pathApi(filePath);
    const real = (realLocation(filePath, realpath) ?? api.resolve(filePath)).normalize('NFC');
    return api === path.win32 ? real.toLowerCase() : real;
  };
  return key(a) === key(b);
}

/** Comparaison par segments de deux chemins réels. */
function contains(realRoot: string | null, realCandidate: string | null, allowRoot: boolean): boolean {
  if (realRoot === null || realCandidate === null) return false;
  const api = pathApi(realRoot);
  const relative = api.relative(realRoot.normalize('NFC'), realCandidate.normalize('NFC'));
  if (relative === '') return allowRoot;
  // Par segments : un fichier nommé `..notes.md` n'est pas une remontée.
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

/**
 * `candidate` est-il dans `root`, une fois les liens suivis des deux côtés ? Le
 * confinement d'un projet qui se partage : git et zip conservent les liens, et
 * `chapters/annexe.md` peut pointer vers `~/.ssh/config`.
 *
 * Les deux côtés sont des chemins réels, sinon tout chapitre serait « dehors » dès que
 * la racine passe par un lien (`/tmp`, `/var/folders` sous macOS, un dossier déplacé).
 * Aucune casse n'est pardonnée ici : `realpath` rend celle du disque, et un disque qui
 * la distingue a bel et bien deux dossiers. La racine elle-même n'est dedans que sur
 * demande (`allowRoot`).
 */
export function isInside(
  root: string,
  candidate: string,
  opts?: { allowRoot?: boolean; realpath?: RealpathFn }
): boolean {
  const realpath = opts?.realpath ?? realpathSync.native;
  return contains(realLocation(root, realpath), realLocation(candidate, realpath), opts?.allowRoot === true);
}

/**
 * Le même verdict qu'`isInside`, sans appel synchrone. Pour ce qui tourne sous la limite
 * de durée d'un export (`export-time-limit.ts`) : un appel synchrone sur un montage mort
 * gèlerait le main, et l'horloge avec lui. Pour un tour de chat aussi : il n'a pas à
 * bloquer le main pour relire son contexte.
 */
export async function isInsideAsync(
  root: string,
  candidate: string,
  opts?: { allowRoot?: boolean }
): Promise<boolean> {
  const [realRoot, realCandidate] = await Promise.all([
    realLocationAsync(root),
    realLocationAsync(candidate),
  ]);
  return contains(realRoot, realCandidate, opts?.allowRoot === true);
}
