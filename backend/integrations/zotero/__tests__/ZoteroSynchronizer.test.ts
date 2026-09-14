import { describe, it, expect } from 'vitest';
import type { IZoteroDataSource } from '../IZoteroDataSource';
import type { ZoteroAttachment, ZoteroCollection, ZoteroItem } from '../ZoteroAPI';
import { ZoteroSynchronizer, type SynchronizeResult } from '../ZoteroSynchronizer';
import { BibTeXParser } from '../../../core/bibliography/BibTeXParser';
import { createCitation, type Citation } from '../../../types/citation';

/**
 * Un seul geste, « Synchroniser avec Zotero », pour ce qui était deux
 * boutons. Le premier import est une synchronisation contre une
 * bibliographie vide ; la suivante doit ne rien trouver à faire.
 */

type Creator = { creatorType: string; lastName?: string; firstName?: string; name?: string };

function item(
  key: string,
  fields: { title: string; lastName?: string; date?: string; dateAdded?: string; itemType?: string; creators?: Creator[]; url?: string }
): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: fields.itemType ?? 'journalArticle',
      title: fields.title,
      date: fields.date ?? '2022',
      dateAdded: fields.dateAdded ?? '2022-01-01',
      url: fields.url,
      creators: fields.creators ?? [{ creatorType: 'author', lastName: fields.lastName ?? 'Dupont', firstName: 'A.' }],
    },
  } as ZoteroItem;
}

function pdf(key: string, filename: string): ZoteroAttachment {
  return {
    key,
    version: 0,
    data: { key, version: 0, itemType: 'attachment', linkMode: 'imported_file', contentType: 'application/pdf', filename },
  };
}

interface Library {
  collections: ZoteroCollection[];
  contents: Record<string, ZoteroItem[]>;
  attachments?: Record<string, ZoteroAttachment[] | 'error'>;
}

function source(library: Library): IZoteroDataSource {
  return {
    listCollections: async () => library.collections,
    listSubcollections: async (key: string) => library.collections.filter((c) => c.data.parentCollection === key),
    getCollection: async (key: string) => library.collections.find((c) => c.key === key)!,
    listItems: async (options?: { collectionKey?: string }) =>
      options?.collectionKey ? (library.contents[options.collectionKey] ?? []) : Object.values(library.contents).flat(),
    getItem: async () => {
      throw new Error('inutile ici');
    },
    getItemChildren: async () => [],
    getItemAttachments: async (key: string) => {
      const found = library.attachments?.[key];
      if (found === 'error') throw new Error('base verrouillée');
      return found ?? [];
    },
    hasAttachments: async () => false,
    downloadFile: async () => ({ filename: '', size: 0 }),
    testConnection: async () => true,
    getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
  };
}

const collection = (key: string, parent?: string): ZoteroCollection => ({
  key,
  version: 0,
  data: { key, version: 0, name: key, parentCollection: parent },
});

/** Relit la bibliographie produite, comme le fera la synchronisation suivante. */
const reread = (result: SynchronizeResult): Citation[] => {
  if (result.status !== 'applied') throw new Error('synchronisation non appliquée');
  return new BibTeXParser().parse(result.bibtex);
};

const applied = (result: SynchronizeResult) => {
  if (result.status !== 'applied') throw new Error(`attendu « applied », reçu « ${result.status} »`);
  return result;
};

describe('premier import', () => {
  it('ajoute toute la collection sans rien demander', async () => {
    const lib: Library = {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [item('AAA', { title: 'Mapping the Latent Past', lastName: 'Hutchinson', date: '2024' })] },
    };

    const result = applied(await new ZoteroSynchronizer(source(lib)).synchronize({ local: [], collectionKey: 'ARTICLE' }));

    expect(result.changed).toBe(true);
    expect(result.report.added).toEqual([{ id: 'Hutchinson_2024', title: 'Mapping the Latent Past' }]);
    expect(result.bibtex).toContain('@article{Hutchinson_2024,');
    expect(result.bibtex).toContain('zoterokey = {AAA}');
  });

  it('lit les sous-collections', async () => {
    // Avant #96, la mise à jour ne les voyait pas et proposait de supprimer
    // ce que l'import venait d'y lire.
    const lib: Library = {
      collections: [collection('THESE'), collection('SOURCES', 'THESE'), collection('PRESSE', 'SOURCES')],
      contents: {
        THESE: [],
        SOURCES: [item('SDN00001', { title: 'Archives SDN', lastName: 'Archives' })],
        PRESSE: [item('TEMPS001', { title: 'Le Temps', lastName: 'Temps' })],
      },
    };
    const sync = new ZoteroSynchronizer(source(lib));

    const first = applied(await sync.synchronize({ local: [], collectionKey: 'THESE' }));
    expect(first.report.added).toHaveLength(2);

    const second = await sync.synchronize({ local: reread(first), collectionKey: 'THESE', savedCollectionKey: 'THESE' });
    expect(second.status).toBe('applied');
    expect(second.report.deleted).toEqual([]);
  });
});

describe('synchronisation suivante', () => {
  const lib = (): Library => ({
    collections: [collection('ARTICLE')],
    contents: {
      ARTICLE: [
        item('CHAP', { title: 'Introduction', lastName: 'Fickers', dateAdded: '2026-09-11' }),
        item('KANS', { title: 'Digital Doping', lastName: 'Kansteiner', url: 'https://example.org/a_b?x=1&y=2' }),
      ],
    },
  });

  it('ne trouve rien à faire juste après un import', async () => {
    const sync = new ZoteroSynchronizer(source(lib()));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    const second = applied(
      await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
    );

    expect(second.changed).toBe(false);
    expect(second.report.added).toEqual([]);
    expect(second.report.modified).toEqual([]);
    expect(second.bibtex).toBe(first.bibtex);
  });

  it('ajoute une nouvelle notice sans déplacer une clé déjà citée', async () => {
    // Le livre du même directeur, entré plus tôt dans Zotero, arrive dans la
    // collection : `[@Fickers_2022]` doit continuer de désigner le chapitre.
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    library.contents.ARTICLE.push(
      item('LIVRE', {
        title: 'Digital History and Hermeneutics',
        itemType: 'book',
        dateAdded: '2020-01-01',
        creators: [{ creatorType: 'editor', lastName: 'Fickers', firstName: 'Andreas' }],
      })
    );
    const second = applied(
      await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
    );

    const keys = Object.fromEntries(reread(second).map((c) => [c.zoteroKey, c.id]));
    expect(keys.CHAP).toBe('Fickers_2022');
    expect(keys.LIVRE).toBe('Fickers_2022a');
    expect(second.report.added).toEqual([{ id: 'Fickers_2022a', title: 'Digital History and Hermeneutics' }]);
  });

  it('applique directement une correction faite dans Zotero', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    library.contents.ARTICLE[1].data.title = 'Digital Doping for Historians';
    const second = await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' });

    expect(second.status).toBe('applied');
    expect(second.report.modified).toEqual([{ id: 'Kansteiner_2022', title: 'Digital Doping', fields: ['title'] }]);
  });
});

describe('ce qui demande confirmation', () => {
  it('une référence sortie de la collection : rien n’est écrit sans accord', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: {
        ARTICLE: [item('AAA', { title: 'Garde', lastName: 'Dupont' }), item('BBB', { title: 'Retirée', lastName: 'Martin' })],
      },
    };
    const sync = new ZoteroSynchronizer(source(library));
    const local = reread(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    library.contents.ARTICLE.pop();
    const asked = await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' });
    expect(asked.status).toBe('needs-confirmation');
    expect(asked.report.deleted).toEqual([{ id: 'Martin_2022', title: 'Retirée' }]);

    const confirmed = applied(
      await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE', confirmed: true })
    );
    expect(reread(confirmed).map((c) => c.zoteroKey)).toEqual(['AAA']);
  });

  it('un changement de collection, même sans suppression', async () => {
    const library: Library = {
      collections: [collection('ANCIENNE'), collection('NOUVELLE')],
      contents: { ANCIENNE: [], NOUVELLE: [item('AAA', { title: 'T' })] },
    };

    const result = await new ZoteroSynchronizer(source(library)).synchronize({
      local: [],
      collectionKey: 'NOUVELLE',
      savedCollectionKey: 'ANCIENNE',
    });

    expect(result.status).toBe('needs-confirmation');
    expect(result.report.collectionChange).toEqual({ from: 'ANCIENNE', to: 'NOUVELLE' });
  });
});

describe('ce que le projet est seul à connaître', () => {
  it('garde les entrées sans lien Zotero', async () => {
    // L'ancien « Importer » réécrivait tout le fichier depuis Zotero et les
    // effaçait.
    const manuelle = createCitation({ id: 'Braudel_1949', type: 'book', author: 'Braudel, Fernand', year: '1949', title: 'La Méditerranée' });
    const library: Library = { collections: [collection('ARTICLE')], contents: { ARTICLE: [item('AAA', { title: 'T' })] } };

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local: [manuelle], collectionKey: 'ARTICLE' }));

    expect(result.report.localOnlyCount).toBe(1);
    expect(reread(result).map((c) => c.id)).toContain('Braudel_1949');
  });

  it('garde les PDF téléchargés et leur chemin local', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [item('AAA', { title: 'Nouveau titre' })] },
      attachments: { AAA: [pdf('PDF1', 'article.pdf')] },
    };
    const local = [
      createCitation({
        id: 'Dupont_2022',
        type: 'article',
        author: 'Dupont, A.',
        year: '2022',
        title: 'Ancien titre',
        zoteroKey: 'AAA',
        zoteroAttachments: [
          { key: 'PDF1', filename: 'article.pdf', contentType: 'application/pdf', downloaded: true, localPath: '/projet/PDFs/article.pdf' },
        ],
      }),
    ];

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local, collectionKey: 'ARTICLE' }));

    expect(result.citations[0].title).toBe('Nouveau titre');
    expect(result.citations[0].zoteroAttachments).toEqual([
      expect.objectContaining({ key: 'PDF1', downloaded: true, localPath: '/projet/PDFs/article.pdf' }),
    ]);
  });

  it('ne déduit pas d’un échec de lecture que les PDF ont disparu', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [item('AAA', { title: 'Nouveau titre' })] },
      attachments: { AAA: 'error' },
    };
    const connu = { key: 'PDF1', filename: 'article.pdf', contentType: 'application/pdf', downloaded: true };
    const local = [
      createCitation({ id: 'Dupont_2022', type: 'article', author: 'Dupont, A.', year: '2022', title: 'Ancien titre', zoteroKey: 'AAA', zoteroAttachments: [connu] }),
    ];

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local, collectionKey: 'ARTICLE' }));

    expect(result.citations[0].zoteroAttachments).toEqual([connu]);
  });

  it('n’annonce que les PDF, pas les instantanés de page web', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [item('AAA', { title: 'T' })] },
      attachments: {
        AAA: [
          pdf('PDF1', 'article.pdf'),
          { key: 'SNAP', version: 0, data: { key: 'SNAP', version: 0, itemType: 'attachment', linkMode: 'imported_url', contentType: 'text/html', filename: 'page.html' } },
        ],
      },
    };

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local: [], collectionKey: 'ARTICLE' }));

    expect(result.citations[0].zoteroAttachments?.map((a) => a.key)).toEqual(['PDF1']);
  });
});

describe('clés', () => {
  it('refait les clés héritées invalides ou portées par deux entrées, et le dit', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: {
        ARTICLE: [
          item('CERT', { title: 'L’invention du quotidien', itemType: 'book', date: '2010', creators: [{ creatorType: 'author', lastName: 'Certeau (de)', firstName: 'Michel' }] }),
          item('HUT1', { title: 'Mapping', lastName: 'Hutchinson', date: '2024', dateAdded: '2024-01-01' }),
          item('HUT2', { title: 'Mapping (doublon)', lastName: 'Hutchinson', date: '2024', dateAdded: '2025-01-01' }),
        ],
      },
    };
    // Bibliographie écrite par une ancienne version.
    const local = [
      createCitation({ id: 'Certeau(de)_2010', type: 'book', author: 'Certeau (de), Michel', year: '2010', title: 'L’invention du quotidien', zoteroKey: 'CERT' }),
      createCitation({ id: 'Hutchinson_2024', type: 'article', author: 'Hutchinson, A.', year: '2024', title: 'Mapping', zoteroKey: 'HUT1' }),
      createCitation({ id: 'Hutchinson_2024', type: 'article', author: 'Hutchinson, A.', year: '2024', title: 'Mapping (doublon)', zoteroKey: 'HUT2' }),
    ];

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local, collectionKey: 'ARTICLE' }));

    expect(result.report.renamedKeys).toEqual(
      expect.arrayContaining([
        { from: 'Certeau(de)_2010', to: 'Certeau_2010', title: 'L’invention du quotidien' },
        { from: 'Hutchinson_2024', to: 'Hutchinson_2024a', title: 'Mapping (doublon)' },
      ])
    );
    const keys = Object.fromEntries(reread(result).map((c) => [c.zoteroKey, c.id]));
    // Le premier entré dans Zotero garde la clé déjà citée.
    expect(keys.HUT1).toBe('Hutchinson_2024');
  });

  it('ne renomme jamais une entrée sans lien Zotero, et évite sa clé', async () => {
    const manuelle = createCitation({ id: 'Dupont_2022', type: 'book', author: 'Dupont, J.', year: '2022', title: 'Livre à la main' });
    const library: Library = { collections: [collection('ARTICLE')], contents: { ARTICLE: [item('AAA', { title: 'Article Zotero' })] } };

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local: [manuelle], collectionKey: 'ARTICLE' }));

    const ids = reread(result).map((c) => c.id);
    expect(ids).toContain('Dupont_2022');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('doublons', () => {
  it('les signale sans les fusionner', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: {
        ARTICLE: [
          item('AAA', { title: 'Mapping the Latent Past: Assessing LLMs', lastName: 'Hutchinson', date: '2024' }),
          item('BBB', { title: 'Mapping the latent past: assessing LLMs', lastName: 'Hutchinson', date: '2024' }),
        ],
      },
    };

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local: [], collectionKey: 'ARTICLE' }));

    expect(result.report.duplicates).toHaveLength(1);
    expect(result.citations).toHaveLength(2);
    expect(result.report.warnings).toEqual([]);
  });
});
