import type { Citation } from './types';

/**
 * Le résumé d'une référence : le champ `abstract` du `.bib`, quelle que soit sa casse.
 *
 * Depuis L05-7, le parseur ne le lit plus comme `notes` (il était réécrit en `note`, que biblatex
 * imprime) : il reste un champ libre, dans `customFields`. La fiche et la recherche du panneau le
 * lisent ici.
 */
export function abstractOf(citation: Pick<Citation, 'customFields'>): string | undefined {
  for (const [name, value] of Object.entries(citation.customFields ?? {})) {
    if (name.toLowerCase() === 'abstract' && value.trim()) return value.trim();
  }
  return undefined;
}
