import type { IZoteroDataSource } from './IZoteroDataSource';
import type { ZoteroItem } from './ZoteroAPI';

/**
 * Contenu d'une collection Zotero, **sous-collections comprises, à toute
 * profondeur** — la seule définition d'une collection pour ClioDeck.
 *
 * Il y en avait trois. `listItems` ne lisait que la collection elle-même ;
 * l'export BibTeX local descendait d'un seul niveau ; l'export de l'API web
 * allait jusqu'au bout. L'import écrivait donc les notices des
 * sous-collections dans le `.bib`, puis la mise à jour — qui ne les voyait
 * pas — proposait de les supprimer, et le contrôle « N notices lues →
 * N entrées écrites » criait à la perte à tort.
 *
 * Une notice rangée dans plusieurs sous-collections n'apparaît qu'une fois.
 * Pièces jointes et notes sont écartées : elles ne sont pas des références.
 *
 * Sans `collectionKey`, toute la bibliothèque.
 */
export async function listCollectionItems(
  source: IZoteroDataSource,
  collectionKey: string | undefined
): Promise<ZoteroItem[]> {
  if (!collectionKey) {
    return (await source.listItems()).filter(isBibliographic);
  }

  const items = new Map<string, ZoteroItem>();
  for (const key of await collectionTree(source, collectionKey)) {
    for (const item of await source.listItems({ collectionKey: key })) {
      if (isBibliographic(item) && !items.has(item.key)) items.set(item.key, item);
    }
  }
  return [...items.values()];
}

/**
 * Clés de la collection et de toutes ses descendantes, la collection en
 * premier. Les collections sont lues une seule fois : `listSubcollections`
 * relit toute la liste à chaque appel, ce qu'une descente récursive
 * multiplierait par la profondeur de l'arbre.
 */
export async function collectionTree(
  source: IZoteroDataSource,
  collectionKey: string
): Promise<string[]> {
  const children = new Map<string, string[]>();
  for (const collection of await source.listCollections()) {
    const parent = collection.data.parentCollection;
    if (typeof parent === 'string' && parent) {
      const siblings = children.get(parent) ?? [];
      siblings.push(collection.key);
      children.set(parent, siblings);
    }
  }

  const tree: string[] = [];
  const seen = new Set<string>();
  const pending = [collectionKey];
  while (pending.length > 0) {
    const key = pending.shift()!;
    // Garde contre une boucle dans des données corrompues.
    if (seen.has(key)) continue;
    seen.add(key);
    tree.push(key);
    pending.push(...(children.get(key) ?? []));
  }
  return tree;
}

function isBibliographic(item: ZoteroItem): boolean {
  return item.data.itemType !== 'attachment' && item.data.itemType !== 'note';
}
