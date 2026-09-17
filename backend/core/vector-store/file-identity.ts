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

import { realpathSync } from 'fs';

export type RealpathFn = (filePath: string) => string;

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
