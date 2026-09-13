import type { ZoteroItem } from './ZoteroAPI';

/**
 * Mise en forme BibTeX des créateurs d'un item Zotero.
 *
 * Partagée par les deux convertisseurs (export et diff) : ils en avaient
 * chacun une copie, et c'est de ce genre de doublon qu'était né
 * `author = {Unknown}` pour tout ouvrage dirigé — seuls les créateurs de
 * rôle `author` étaient lus, un livre qui n'a que des `editor` perdait ses
 * noms. Un champ vide vaut mieux qu'un faux nom : « Unknown » agrégeait
 * des œuvres étrangères l'une à l'autre.
 */
export function formatCreators(item: ZoteroItem, role: 'author' | 'editor'): string {
  return (item.data.creators ?? [])
    .filter((c) => c.creatorType === role)
    .map((c) => {
      if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
      return c.name || c.lastName || '';
    })
    .filter(Boolean)
    .join(' and ');
}
