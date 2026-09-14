import { describe, it, expect } from 'vitest';
import type { IZoteroDataSource } from '../IZoteroDataSource';
import type { ZoteroCollection, ZoteroItem } from '../ZoteroAPI';
import { collectionTree, listCollectionItems } from '../collectionItems';

/**
 * Une collection, pour ClioDeck, c'est la collection et toutes ses
 * sous-collections. L'import les lisait (en partie), la mise à jour non :
 * elle proposait alors de supprimer les notices qu'un import venait d'écrire.
 *
 *   Thèse
 *   ├── Sources            (Archives SDN)
 *   │   └── Presse         (Le Temps, et Archives SDN rangée deux fois)
 *   └── Historiographie    (Farge)
 *   Autre projet           (Hors sujet)
 */

function collection(key: string, name: string, parent?: string): ZoteroCollection {
  return { key, version: 0, data: { key, version: 0, name, parentCollection: parent } };
}

function item(key: string, title: string, itemType = 'journalArticle'): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType,
      title,
      creators: [{ creatorType: 'author', lastName: title.split(' ')[0], firstName: 'X' }],
      date: '2024',
    },
  } as ZoteroItem;
}

const COLLECTIONS = [
  collection('THESE', 'Thèse'),
  collection('SOURCES', 'Sources', 'THESE'),
  collection('PRESSE', 'Presse', 'SOURCES'),
  collection('HISTO', 'Historiographie', 'THESE'),
  collection('AUTRE', 'Autre projet'),
];

const CONTENTS: Record<string, ZoteroItem[]> = {
  THESE: [],
  SOURCES: [item('SDN00001', 'Archives SDN'), item('NOTE0001', 'Note de lecture', 'note')],
  PRESSE: [item('TEMPS001', 'Temps presse'), item('SDN00001', 'Archives SDN')],
  HISTO: [item('FARGE001', 'Farge archives'), item('PDF00001', 'farge.pdf', 'attachment')],
  AUTRE: [item('HORS0001', 'Hors sujet')],
};

function source(): IZoteroDataSource {
  return {
    listCollections: async () => COLLECTIONS,
    listSubcollections: async (key: string) => COLLECTIONS.filter((c) => c.data.parentCollection === key),
    getCollection: async (key: string) => COLLECTIONS.find((c) => c.key === key)!,
    listItems: async (options?: { collectionKey?: string }) =>
      options?.collectionKey ? (CONTENTS[options.collectionKey] ?? []) : Object.values(CONTENTS).flat(),
    getItem: async () => {
      throw new Error('inutile ici');
    },
    getItemChildren: async () => [],
    getItemAttachments: async () => [],
    hasAttachments: async () => false,
    downloadFile: async () => ({ filename: '', size: 0 }),
    testConnection: async () => true,
    getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
  };
}

describe('collectionTree', () => {
  it('descend à toute profondeur, la collection en premier', () => {
    return expect(collectionTree(source(), 'THESE')).resolves.toEqual(['THESE', 'SOURCES', 'HISTO', 'PRESSE']);
  });

  it('ne boucle pas sur des données corrompues', async () => {
    const cyclic = source();
    cyclic.listCollections = async () => [collection('A', 'A', 'B'), collection('B', 'B', 'A')];
    await expect(collectionTree(cyclic, 'A')).resolves.toEqual(['A', 'B']);
  });
});

describe('listCollectionItems', () => {
  it('lit les notices des sous-collections et des sous-sous-collections', async () => {
    const keys = (await listCollectionItems(source(), 'THESE')).map((i) => i.key);
    expect(keys.sort()).toEqual(['FARGE001', 'SDN00001', 'TEMPS001']);
  });

  it('ne compte qu’une fois une notice rangée à deux endroits', async () => {
    const keys = (await listCollectionItems(source(), 'THESE')).map((i) => i.key);
    expect(keys.filter((k) => k === 'SDN00001')).toHaveLength(1);
  });

  it('écarte notes et pièces jointes', async () => {
    const types = (await listCollectionItems(source(), 'THESE')).map((i) => i.data.itemType);
    expect(types).not.toContain('note');
    expect(types).not.toContain('attachment');
  });

  it('ne déborde pas sur une collection voisine', async () => {
    const keys = (await listCollectionItems(source(), 'THESE')).map((i) => i.key);
    expect(keys).not.toContain('HORS0001');
  });
});
