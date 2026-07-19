/**
 * Budget de troncature des résultats d'outils MCP — source unique.
 *
 * Cette constante était recopiée dans six outils. Portée de 400 à 2 000 puis
 * à 4 000 sans que les tests suivent, elle a produit deux fois le même bug :
 * `searchHal` d'abord, puis `searchObsidian`/`searchTropy`/`searchZotero`,
 * ces trois-là restés rouges des semaines sans que personne le voie (les
 * gardes ABI SQLite empêchaient la suite de tourner). Un seul endroit à
 * changer, et les tests s'y réfèrent au lieu de coder le nombre en dur.
 */

/** Longueur maximale d'un contenu renvoyé dans un résultat d'outil. */
export const TRUNCATE = 4000;

/** Coupe `s` au budget et signale la troncature par une ellipse. */
export function truncate(s: string, max: number = TRUNCATE): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
