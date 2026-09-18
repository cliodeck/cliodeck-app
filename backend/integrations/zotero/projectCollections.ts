/**
 * Les collections Zotero qui concernent un projet.
 *
 * La synchronisation enregistrait toute la bibliothèque (`listCollections()`) :
 * 152 collections sur un projet réel dont la collection comptait 23
 * sous-collections — le filtre par collection de l'assistant proposait donc
 * des dizaines de collections sans aucun document (#130).
 *
 * On garde :
 *   - la collection du projet et toute sa descendance (l'arbre que
 *     l'historien a choisi d'importer) ;
 *   - les collections auxquelles appartiennent effectivement les notices du
 *     projet — une notice peut être rangée ailleurs aussi, et filtrer sur ces
 *     collections-là a un sens ;
 *   - les ancêtres de tout ce qui précède, sans quoi l'arbre affiché aurait
 *     des trous et le filtre récursif (`getDocumentIdsInCollections`)
 *     perdrait des branches.
 */

export interface CollectionNode {
  key: string;
  name: string;
  parentKey?: string;
}

export function collectionsForProject(
  all: CollectionNode[],
  projectCollectionKey: string | undefined,
  bibtexKeyToCollections: Record<string, string[]>,
): CollectionNode[] {
  const byKey = new Map(all.map((c) => [c.key, c]));
  const keep = new Set<string>();

  if (projectCollectionKey && byKey.has(projectCollectionKey)) {
    const childrenOf = new Map<string, string[]>();
    for (const c of all) {
      if (c.parentKey) (childrenOf.get(c.parentKey) ?? childrenOf.set(c.parentKey, []).get(c.parentKey)!).push(c.key);
    }
    const stack = [projectCollectionKey];
    while (stack.length) {
      const key = stack.pop()!;
      if (keep.has(key)) continue;
      keep.add(key);
      stack.push(...(childrenOf.get(key) ?? []));
    }
  }

  for (const keys of Object.values(bibtexKeyToCollections)) {
    for (const key of keys) if (byKey.has(key)) keep.add(key);
  }

  for (const key of [...keep]) {
    let parent = byKey.get(key)?.parentKey;
    const seen = new Set<string>();
    while (parent && byKey.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      keep.add(parent);
      parent = byKey.get(parent)?.parentKey;
    }
  }

  return all.filter((c) => keep.has(c.key));
}
