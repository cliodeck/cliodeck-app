import type { Citation, ReadingNoteSummary } from './types';

/**
 * Qui possède quoi sur une référence.
 *
 * - **Zotero** : ses tags (`zoteroTags`), en lecture seule. Les tags
 *   *automatiques* — importés par Zotero depuis les métadonnées d'un éditeur —
 *   sont masqués par défaut : 77 pour 5 manuels sur une collection réelle,
 *   ils noyaient le filtre. Ceux qui s'en servent peuvent les afficher.
 * - **Le fichier** : le champ `tags` d'une référence sans lien Zotero.
 * - **Le projet** : les étiquettes, écrites dans la note de lecture.
 */

/** Note de lecture d'une référence : clé Zotero d'abord, clé de citation ensuite. */
export function readingNoteOf(
  citation: Pick<Citation, 'id' | 'zoteroKey'>,
  notes: ReadingNoteSummary[]
): ReadingNoteSummary | undefined {
  if (citation.zoteroKey) {
    const byZotero = notes.find((n) => n.zoteroKey === citation.zoteroKey);
    if (byZotero) return byZotero;
  }
  return notes.find((n) => n.citekey === citation.id && (!n.zoteroKey || !citation.zoteroKey));
}

/** Étiquettes du projet pour une référence. */
export function projectTagsOf(citation: Pick<Citation, 'id' | 'zoteroKey'>, notes: ReadingNoteSummary[]): string[] {
  return readingNoteOf(citation, notes)?.tags ?? [];
}

/** Tags bibliographiques affichés : Zotero (manuels, et automatiques si demandé) ou fichier. */
export function sourceTagsOf(citation: Citation, showAutomatic: boolean): string[] {
  if (citation.zoteroTags) {
    return citation.zoteroTags.filter((t) => showAutomatic || !t.automatic).map((t) => t.tag);
  }
  return citation.tags ?? [];
}

/** Nombre de tags automatiques Zotero masqués. */
export function hiddenAutomaticCount(citation: Citation, showAutomatic: boolean): number {
  if (showAutomatic || !citation.zoteroTags) return 0;
  return citation.zoteroTags.filter((t) => t.automatic).length;
}

/** Tous les tags qu'on peut rechercher ou filtrer pour une référence. */
export function referenceTags(citation: Citation, notes: ReadingNoteSummary[], showAutomatic: boolean): string[] {
  return [...new Set([...sourceTagsOf(citation, showAutomatic), ...projectTagsOf(citation, notes)])];
}
