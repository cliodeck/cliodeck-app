/**
 * Fusionner deux listes de références : celles qui sont là, puis celles qui arrivent et n'y sont
 * pas encore. Le main s'en sert pour écrire la fusion dans le `.bib` du projet, le renderer pour
 * la fusion en mémoire, sans projet ouvert.
 */
import type { Citation } from '../../types/citation';

export function mergeCitationLists<T extends Pick<Citation, 'id' | 'zoteroKey'>>(
  existing: readonly T[],
  incoming: readonly T[]
): { merged: T[]; newCount: number; duplicates: number } {
  // Un doublon, c'est le même item Zotero — pas la même clé BibTeX.
  // Deux œuvres distinctes peuvent partager une clé (trois ouvrages en
  // `Unknown_2022`, mesuré) : déduire le doublon de l'`id` en écartait
  // alors une à l'import. Le `zoteroKey` fait foi quand il existe.
  const existingZoteroKeys = new Set(existing.map((c) => c.zoteroKey).filter(Boolean) as string[]);
  const existingIds = new Set(existing.map((c) => c.id));

  const added: T[] = [];
  let duplicates = 0;
  for (const citation of incoming) {
    const isDuplicate = citation.zoteroKey
      ? existingZoteroKeys.has(citation.zoteroKey)
      : existingIds.has(citation.id);

    if (isDuplicate) {
      duplicates++;
      continue;
    }
    added.push(citation);
    if (citation.zoteroKey) existingZoteroKeys.add(citation.zoteroKey);
    existingIds.add(citation.id);
  }

  return { merged: [...existing, ...added], newCount: added.length, duplicates };
}
