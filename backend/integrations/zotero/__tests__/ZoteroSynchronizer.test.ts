import { describe, it, expect } from 'vitest';
import type { IZoteroDataSource } from '../IZoteroDataSource';
import type { ZoteroAttachment, ZoteroCollection, ZoteroItem } from '../ZoteroAPI';
import { ZoteroSynchronizer, type SyncReport, type SynchronizeResult } from '../ZoteroSynchronizer';
import { BibTeXParser } from '../../../core/bibliography/BibTeXParser';
import { auditParsedBib } from '../../../core/bibliography/bibAudit';
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
  notes?: Record<string, Array<{ key: string; note: string }>>;
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
    getItemNotes: async (key: string) => library.notes?.[key] ?? [],
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

/** L'accord de l'auteur, donné sur le rapport qu'il a lu. */
const approve = (report: SyncReport) => ({ confirmation: report.confirmation });

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
    expect(asked.report.deleted).toEqual([{ id: 'Martin_2022', title: 'Retirée', zoteroKey: 'BBB' }]);
    expect(asked.report.confirmation).toEqual({ collectionKey: 'ARTICLE', collectionChange: null, deletedKeys: ['BBB'] });

    const confirmed = applied(
      await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE', ...approve(asked.report) })
    );
    expect(reread(confirmed).map((c) => c.zoteroKey)).toEqual(['AAA']);
  });

  it('un changement de collection, même sans suppression', async () => {
    const library: Library = {
      collections: [collection('ANCIENNE'), collection('NOUVELLE')],
      contents: { ANCIENNE: [], NOUVELLE: [item('AAA', { title: 'T' })] },
    };
    const sync = new ZoteroSynchronizer(source(library));
    const input = { local: [], collectionKey: 'NOUVELLE', savedCollectionKey: 'ANCIENNE' };

    const result = await sync.synchronize(input);

    expect(result.status).toBe('needs-confirmation');
    expect(result.report.collectionChange).toEqual({ from: 'ANCIENNE', to: 'NOUVELLE' });
    expect(applied(await sync.synchronize({ ...input, ...approve(result.report) })).report.added).toHaveLength(1);
  });
});

/**
 * L'accord vaut pour le rapport que l'auteur a lu, pas pour ce que Zotero contient au
 * moment du second appel : un booléen global laissait passer une suppression que la boîte
 * n'avait jamais montrée (S07-1-0).
 */
describe('un accord ne couvre que le rapport lu', () => {
  const threeItems = (): Library => ({
    collections: [collection('ARTICLE'), collection('AUTRE')],
    contents: {
      ARTICLE: [
        item('AAA', { title: 'Garde', lastName: 'Dupont' }),
        item('BBB', { title: 'Retirée', lastName: 'Martin' }),
        item('CCC', { title: 'Retirée pendant la lecture', lastName: 'Durand' }),
      ],
      AUTRE: [item('DDD', { title: 'Autre', lastName: 'Petit' })],
    },
  });

  async function firstImport(library: Library) {
    const sync = new ZoteroSynchronizer(source(library));
    const local = reread(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    return { sync, local };
  }

  it('Zotero retire une autre notice pendant la lecture : la suppression nouvelle redemande l’accord', async () => {
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    const input = { local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' };

    library.contents.ARTICLE = library.contents.ARTICLE.filter((i) => i.key !== 'BBB');
    const asked = await sync.synchronize(input);
    expect(asked.report.deleted.map((d) => d.zoteroKey)).toEqual(['BBB']);

    library.contents.ARTICLE = library.contents.ARTICLE.filter((i) => i.key !== 'CCC');
    const again = await sync.synchronize({ ...input, ...approve(asked.report) });

    expect(again.status).toBe('needs-confirmation');
    expect(again.report.deleted).toEqual(
      expect.arrayContaining([expect.objectContaining({ zoteroKey: 'CCC', title: 'Retirée pendant la lecture' })])
    );
    expect(again.report.confirmation.deletedKeys).toEqual(expect.arrayContaining(['BBB', 'CCC']));

    // Le nouveau rapport, lu et accepté à son tour, s'applique.
    const done = applied(await sync.synchronize({ ...input, ...approve(again.report) }));
    expect(reread(done).map((c) => c.zoteroKey)).toEqual(['AAA']);
  });

  it('une autre collection que celle du rapport : nouvel accord', async () => {
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    const asked = await sync.synchronize({ local, collectionKey: 'AUTRE', savedCollectionKey: 'ARTICLE' });
    expect(asked.report.confirmation.collectionChange).toEqual({ from: 'ARTICLE', to: 'AUTRE' });

    // L'accord porte sur AUTRE ; la demande, sur une troisième collection.
    library.collections.push(collection('TROISIEME'));
    library.contents.TROISIEME = [item('EEE', { title: 'Troisième', lastName: 'Leroy' })];
    const elsewhere = await sync.synchronize({
      local,
      collectionKey: 'TROISIEME',
      savedCollectionKey: 'ARTICLE',
      ...approve(asked.report),
    });

    expect(elsewhere.status).toBe('needs-confirmation');
    expect(elsewhere.report.collectionChange).toEqual({ from: 'ARTICLE', to: 'TROISIEME' });
  });

  it('un projet qui suivait une autre collection que celle du rapport : nouvel accord', async () => {
    // Le cas du projet B confirmé avec le rapport de A : même collection visée, mais B en
    // suivait une autre, et ses entrées liées à Zotero partiraient toutes.
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    library.contents.ARTICLE.pop();
    const askedInA = await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' });
    expect(askedInA.report.confirmation.collectionChange).toBeNull();

    const projectB = reread(await sync.synchronize({ local: [], collectionKey: 'AUTRE' }));
    const inB = await sync.synchronize({
      local: projectB,
      collectionKey: 'ARTICLE',
      savedCollectionKey: 'AUTRE',
      ...approve(askedInA.report),
    });

    expect(inB.status).toBe('needs-confirmation');
    expect(inB.report.deleted.map((d) => d.zoteroKey)).toEqual(['DDD']);
  });

  it('une autre collection enregistrée pendant la lecture, mêmes suppressions : nouvel accord', async () => {
    // L'historien enregistre une autre collection dans les Paramètres Zotero du projet pendant
    // que la boîte est ouverte. Même collection visée, mêmes suppressions, mais la boîte ne
    // montrait aucun changement de collection : l'appliquer écraserait ce qu'il vient d'enregistrer.
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    library.contents.ARTICLE.pop();
    const asked = await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' });
    expect(asked.report.confirmation).toEqual({ collectionKey: 'ARTICLE', collectionChange: null, deletedKeys: ['CCC'] });

    const again = await sync.synchronize({
      local,
      collectionKey: 'ARTICLE',
      savedCollectionKey: 'AUTRE',
      ...approve(asked.report),
    });

    expect(again.status).toBe('needs-confirmation');
    expect(again.report.confirmation).toEqual({
      collectionKey: 'ARTICLE',
      collectionChange: { from: 'AUTRE', to: 'ARTICLE' },
      deletedKeys: ['CCC'],
    });
  });

  it('le changement de collection lu ne partait pas de la même collection : nouvel accord', async () => {
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    const asked = await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'AUTRE' });
    expect(asked.report.confirmation).toEqual({
      collectionKey: 'ARTICLE',
      collectionChange: { from: 'AUTRE', to: 'ARTICLE' },
      deletedKeys: [],
    });

    const again = await sync.synchronize({
      local,
      collectionKey: 'ARTICLE',
      savedCollectionKey: 'TROISIEME',
      ...approve(asked.report),
    });

    expect(again.status).toBe('needs-confirmation');
    expect(again.report.collectionChange).toEqual({ from: 'TROISIEME', to: 'ARTICLE' });
  });

  it('témoin : une notice du rapport revenue dans la collection, l’accord vaut encore', async () => {
    const library = threeItems();
    const { sync, local } = await firstImport(library);
    const input = { local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' };
    const removed = library.contents.ARTICLE.pop()!;
    const asked = await sync.synchronize(input);

    library.contents.ARTICLE.push(removed);
    const done = applied(await sync.synchronize({ ...input, ...approve(asked.report) }));

    expect(done.report.deleted).toEqual([]);
    expect(reread(done)).toHaveLength(3);
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

  // Le .bib voyage (coauteurs, autre Mac) : il ne dit plus le chemin local de l'auteur, et se
  // relit dans un projet renommé (S07-2-1).
  it('écrit relatif au dossier du .bib le chemin d’un PDF qui s’y trouve, absolu celui d’un PDF rangé ailleurs', async () => {
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [item('AAA', { title: 'T' }), item('BBB', { title: 'U', lastName: 'Durand' })] },
    };
    const local = [
      createCitation({ id: 'Dupont_2022', type: 'article', author: 'Dupont, A.', year: '2022', title: 'T', zoteroKey: 'AAA', file: '/Users/jean/These/PDFs/a.pdf' }),
      createCitation({ id: 'Durand_2022', type: 'article', author: 'Durand, A.', year: '2022', title: 'U', zoteroKey: 'BBB', file: '/Users/jean/Zotero/storage/XY/b.pdf' }),
    ];

    const result = applied(
      await new ZoteroSynchronizer(source(library)).synchronize({ local, collectionKey: 'ARTICLE', bibDir: '/Users/jean/These' })
    );

    expect(result.bibtex).toContain('file = {PDFs/a.pdf}');
    expect(result.bibtex).toContain('file = {/Users/jean/Zotero/storage/XY/b.pdf}');
    expect(result.bibtex).not.toContain('/Users/jean/These');
    // En mémoire, le chemin reste absolu : le panneau n'en voit pas d'autre.
    expect(result.citations.find((c) => c.id === 'Dupont_2022')?.file).toBe('/Users/jean/These/PDFs/a.pdf');
    // Relu depuis le dossier du .bib, même renommé, il mène au PDF.
    const reread = new BibTeXParser().parse(result.bibtex, '/Users/jean/These-2026');
    expect(reread.find((c) => c.id === 'Dupont_2022')?.file).toBe('/Users/jean/These-2026/PDFs/a.pdf');
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
        { from: 'Certeau(de)_2010', to: 'Certeau_2010', title: 'L’invention du quotidien', zoteroKey: 'CERT' },
        { from: 'Hutchinson_2024', to: 'Hutchinson_2024a', title: 'Mapping (doublon)', zoteroKey: 'HUT2' },
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

describe('tags et notes Zotero', () => {
  const withTags = (): Library => {
    const notice = item('AAA', { title: 'Digital Doping', lastName: 'Kansteiner' });
    notice.data.tags = [
      { tag: 'hermeneutics' },
      { tag: 'Artificial Intelligence', type: 1 },
    ];
    return {
      collections: [collection('ARTICLE')],
      contents: { ARTICLE: [notice] },
      notes: { AAA: [{ key: 'NOTE1', note: '<div><p>À relire&nbsp;: <b>chapitre 3</b></p><p>Voir aussi Hartog</p></div>' }] },
    };
  };

  it('sépare tags manuels et automatiques, et lit les notes en texte', async () => {
    const result = applied(await new ZoteroSynchronizer(source(withTags())).synchronize({ local: [], collectionKey: 'ARTICLE' }));
    const c = result.citations[0];

    expect(c.zoteroTags).toEqual([
      { tag: 'hermeneutics', automatic: false },
      { tag: 'Artificial Intelligence', automatic: true },
    ]);
    expect(c.zoteroNotes).toEqual([{ key: 'NOTE1', text: 'À relire : chapitre 3\nVoir aussi Hartog' }]);
    // Données de Zotero : elles ne vont pas dans le .bib, qui voyage.
    expect(result.bibtex).not.toContain('hermeneutics');
    expect(result.bibtex).not.toContain('tags =');
  });

  it('propage un tag ajouté dans Zotero', async () => {
    const library = withTags();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    library.contents.ARTICLE[0].data.tags!.push({ tag: 'craft' });
    const second = applied(
      await sync.synchronize({ local: first.citations, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
    );

    expect(second.report.modified.map((m) => m.fields)).toEqual([['zoteroTags']]);
    expect(second.citations[0].zoteroTags?.map((t) => t.tag)).toContain('craft');
  });

  it('retire du .bib les tags qu’une ancienne version y écrivait', async () => {
    const library = withTags();
    const legacy = createCitation({
      id: 'Kansteiner_2022',
      type: 'article',
      author: 'Kansteiner, A.',
      year: '2022',
      title: 'Digital Doping',
      zoteroKey: 'AAA',
      tags: ['hermeneutics', 'Artificial Intelligence'],
    });

    const result = applied(await new ZoteroSynchronizer(source(library)).synchronize({ local: [legacy], collectionKey: 'ARTICLE' }));

    expect(result.citations[0].tags).toBeUndefined();
    expect(result.bibtex).not.toContain('tags =');
  });

  it('garde les notes connues quand leur lecture échoue', async () => {
    const library = withTags();
    const failing = source(library);
    failing.getItemNotes = async () => {
      throw new Error('base verrouillée');
    };
    const known = createCitation({
      id: 'Kansteiner_2022', type: 'article', author: 'Kansteiner, A.', year: '2022', title: 'Digital Doping', zoteroKey: 'AAA',
      zoteroNotes: [{ key: 'NOTE1', text: 'Note connue' }],
    });

    const result = applied(await new ZoteroSynchronizer(failing).synchronize({ local: [known], collectionKey: 'ARTICLE' }));

    expect(result.citations[0].zoteroNotes).toEqual([{ key: 'NOTE1', text: 'Note connue' }]);
  });
});

/**
 * Le résumé suit une règle à part (J3) : Zotero en a un → il est écrit, et l'emporte sur celui du
 * `.bib` ; Zotero n'en a pas → celui du `.bib` reste. Un résumé venu d'un `.bib` (Better BibTeX,
 * Mendeley, BibDesk) n'est jamais effacé parce que Zotero n'en a pas.
 */
describe('résumé', () => {
  const lib = (): Library => ({
    collections: [collection('ARTICLE')],
    contents: { ARTICLE: [item('AAA', { title: 'Digital Doping', lastName: 'Kansteiner' })] },
  });

  /** Le `.bib` d'un premier import, auquel on ajoute un résumé, comme le ferait un import de Better BibTeX. */
  const withBibAbstract = (bibtex: string, zoteroKey: string, abstract: string): string =>
    bibtex.replace(`zoterokey = {${zoteroKey}}`, `zoterokey = {${zoteroKey}},\n  abstract = {${abstract}}`);

  it('Zotero a un résumé, le .bib n’en a pas : il est écrit, et la notice compte comme modifiée', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    library.contents.ARTICLE[0].data.abstractNote = 'Un article sur l’IA et le métier d’historien.';
    const second = applied(
      await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
    );

    expect(second.changed).toBe(true);
    expect(second.report.modified).toEqual([{ id: 'Kansteiner_2022', title: 'Digital Doping', fields: ['abstract'] }]);
    expect(reread(second)[0].customFields?.abstract).toBe('Un article sur l’IA et le métier d’historien.');
  });

  it('Zotero n’a pas de résumé, le .bib en a un : il reste, que la notice change ou non', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    const local = new BibTeXParser().parse(withBibAbstract(first.bibtex, 'AAA', 'Résumé saisi dans le .bib'));

    const unchanged = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));
    expect(unchanged.changed).toBe(false);
    expect(unchanged.report.modified).toEqual([]);

    library.contents.ARTICLE[0].data.title = 'Digital Doping for Historians';
    const retitled = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));
    expect(retitled.report.modified.map((m) => m.fields)).toEqual([['title']]);
    expect(reread(retitled)[0].customFields?.abstract).toBe('Résumé saisi dans le .bib');
  });

  it('Zotero a un autre résumé que le .bib : celui de Zotero l’emporte', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    const local = new BibTeXParser().parse(withBibAbstract(first.bibtex, 'AAA', 'Ancien résumé, retouché à la main'));

    library.contents.ARTICLE[0].data.abstractNote = 'Le résumé tenu à jour dans Zotero.';
    const second = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));

    expect(second.report.modified.map((m) => m.fields)).toEqual([['abstract']]);
    expect(reread(second)[0].customFields?.abstract).toBe('Le résumé tenu à jour dans Zotero.');
    expect(second.bibtex).not.toContain('Ancien résumé');
  });

  // La comparaison des autres champs ne garde que les lettres ASCII et les blancs : un résumé chinois
  // y vaut une chaîne vide, comme un résumé absent, et serait passé pour déjà présent. Celle du
  // résumé garde toutes les écritures, mais pas les signes : un résumé fait de seuls signes est
  // nouveau parce que le `.bib` n'en a pas, quoi que dise la comparaison.
  const firstAbstracts: Record<string, string> = {
    'sans lettre latine ni espace (chinois)': '本文讨论档案与数字史学的关系。',
    'fait de seuls signes': '***',
  };
  for (const [name, text] of Object.entries(firstAbstracts)) {
    it(`un résumé ${name}, absent du .bib, est écrit aussi`, async () => {
      const library = lib();
      const sync = new ZoteroSynchronizer(source(library));
      const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

      library.contents.ARTICLE[0].data.abstractNote = text;
      const second = applied(
        await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
      );

      expect(second.report.modified.map((m) => m.fields)).toEqual([['abstract']]);
      expect(reread(second)[0].customFields?.abstract).toBe(text);

      const third = applied(
        await sync.synchronize({ local: reread(second), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
      );
      expect(third.changed).toBe(false);
    });
  }

  it('accolades, caractères spéciaux et sauts de ligne : relu tel qu’écrit, puis plus rien à faire', async () => {
    const raw =
      'Sur {les} archives} : 50 % des cas & d’autres_choses, #1, $2, ~3, C:\\dossier --- « guillemets », contact@example.org.\n\n' +
      'Second paragraphe.';
    const library = lib();
    library.contents.ARTICLE[0].data.abstractNote = raw;
    const sync = new ZoteroSynchronizer(source(library));

    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    // Les sauts de ligne ne survivent pas à la relecture (le parseur réduit les blancs), et `---`
    // s'y lit en tiret cadratin, comme dans tout champ libre ; le reste revient tel quel.
    expect(reread(first)[0].customFields?.abstract).toBe(raw.replace(/\s+/g, ' ').replace('---', '—'));

    const second = applied(
      await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
    );
    // Rien à écrire : le fichier garde le résumé tel que la première synchronisation l'a écrit.
    expect(second.changed).toBe(false);
    expect(second.report.modified).toEqual([]);
  });

  it('première synchronisation après la mise à jour : seules les notices dont Zotero a un résumé nouveau changent, sans rien demander', async () => {
    // Avant la mise à jour, `toCitation` ne lisait pas `abstractNote` : le `.bib` n'a que les
    // résumés venus d'ailleurs (ici, B et C, écrits à la manière de Better BibTeX, et D).
    const library: Library = {
      collections: [collection('ARTICLE')],
      contents: {
        ARTICLE: [
          item('AAA', { title: 'A', lastName: 'Alpha' }),
          item('BBB', { title: 'B', lastName: 'Beta' }),
          item('CCC', { title: 'C', lastName: 'Gamma' }),
          item('DDD', { title: 'D', lastName: 'Delta' }),
          item('EEE', { title: 'E', lastName: 'Epsilon' }),
        ],
      },
    };
    const sync = new ZoteroSynchronizer(source(library));
    const before = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    let bib = before.bibtex;
    bib = withBibAbstract(bib, 'BBB', '50 \\% des cas --- en {France}');
    bib = withBibAbstract(bib, 'CCC', 'Résumé retouché dans le .bib');
    bib = withBibAbstract(bib, 'DDD', 'Résumé que seul le .bib connaît');
    const local = new BibTeXParser().parse(bib);

    const [a, b, c] = library.contents.ARTICLE;
    a.data.abstractNote = 'Résumé que seul Zotero connaît';
    b.data.abstractNote = '50 % des cas — en France';
    c.data.abstractNote = 'Résumé de Zotero';

    const after = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));

    expect(after.report.added).toEqual([]);
    expect(after.report.deleted).toEqual([]);
    expect(after.report.modified).toEqual([
      { id: 'Alpha_2022', title: 'A', fields: ['abstract'] },
      { id: 'Gamma_2022', title: 'C', fields: ['abstract'] },
    ]);
    expect(after.report.unchangedCount).toBe(3);
    const abstracts = Object.fromEntries(reread(after).map((x) => [x.zoteroKey, x.customFields?.abstract]));
    expect(abstracts).toEqual({
      AAA: 'Résumé que seul Zotero connaît',
      BBB: '50 % des cas — en France',
      CCC: 'Résumé de Zotero',
      DDD: 'Résumé que seul le .bib connaît',
      EEE: undefined,
    });
  });

  // La comparaison des autres champs ne garde que les lettres ASCII : un résumé chinois s'y réduit
  // à rien, un résumé russe ou grec à ses blancs, et « é » → « è » n'y change rien. Changé dans
  // Zotero, il passait pour identique et n'était jamais écrit.
  const rewrites: Record<string, [string, string]> = {
    chinois: ['本文讨论档案与数字史学的关系。', '本文讨论上海档案馆的民国档案。'],
    russe: ['Это статья об архивах.', 'Это книга о музеях.'],
    grec: ['Μελέτη των αρχείων.', 'Ιστορία των μουσείων.'],
    'accent seul': ['Résumé de la période', 'Résumè de la période'],
    hindi: ['पुरालेख का इतिहास', 'पुरालेखों का इतिहास'],
  };
  for (const [script, [before, after]] of Object.entries(rewrites)) {
    it(`un résumé changé dans Zotero l’emporte aussi hors de l’alphabet latin : ${script}`, async () => {
      const library = lib();
      library.contents.ARTICLE[0].data.abstractNote = before;
      const sync = new ZoteroSynchronizer(source(library));
      const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

      library.contents.ARTICLE[0].data.abstractNote = after;
      const second = applied(
        await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
      );

      expect(second.report.modified.map((m) => m.fields)).toEqual([['abstract']]);
      expect(reread(second)[0].customFields?.abstract).toBe(after);
    });
  }

  it('première synchronisation : un résumé non latin du .bib, autre que celui de Zotero, est remplacé', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    const local = new BibTeXParser().parse(withBibAbstract(first.bibtex, 'AAA', 'Это статья об архивах.'));

    library.contents.ARTICLE[0].data.abstractNote = 'Это книга о музеях.';
    const second = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));

    expect(second.report.modified.map((m) => m.fields)).toEqual([['abstract']]);
    expect(reread(second)[0].customFields?.abstract).toBe('Это книга о музеях.');
  });

  // La comparaison du résumé ne doit pas faire passer pour « modifiée », à chaque synchronisation, une
  // notice dont le `.bib` relu diffère du texte de Zotero par la seule écriture du fichier.
  const roundTrips: Record<string, string> = {
    'HTML de Crossref': '<jats:p>Cet article <i>examine</i> les archives.</jats:p>',
    'commandes LaTeX': 'Une étude \\emph{importante} des \\textit{archives}, l’\\\'etude.',
    'mathématiques': 'Avec $x^2$ et a^b.',
    'barres obliques inverses': 'Chemin C:\\Users\\dossier et \\\\ double.',
    'fins de ligne Windows et tabulations': 'Ligne un.\r\nLigne deux.\tCol2',
    'tirets et guillemets': 'Entre 1914--1918, ``cité\'\' et "dit" --- puis ...',
    'espace insécable': 'Mot\u00a0: suite',
    accolades: '{\\bf gras} et {groupe}',
    'chinois et russe': '本文讨论档案。 Это статья.',
  };
  for (const [name, text] of Object.entries(roundTrips)) {
    it(`relu après écriture, le résumé n’est plus « modifié » : ${name}`, async () => {
      const library = lib();
      library.contents.ARTICLE[0].data.abstractNote = text;
      const sync = new ZoteroSynchronizer(source(library));
      const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

      const second = applied(
        await sync.synchronize({ local: reread(first), collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' })
      );

      expect(second.report.modified).toEqual([]);
      expect(second.changed).toBe(false);
    });
  }

  it('le même résumé, composé autrement (NFC dans le .bib, NFD dans Zotero) : rien à réécrire', async () => {
    const library = lib();
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));
    const local = new BibTeXParser().parse(withBibAbstract(first.bibtex, 'AAA', 'Résumé de la période'.normalize('NFC')));

    library.contents.ARTICLE[0].data.abstractNote = 'Résumé de la période'.normalize('NFD');
    const second = applied(await sync.synchronize({ local, collectionKey: 'ARTICLE', savedCollectionKey: 'ARTICLE' }));

    expect(second.report.modified).toEqual([]);
    expect(second.changed).toBe(false);
  });

  // ClioDeck écrit chaque valeur sur une ligne (`bibAudit`) : une ligne du résumé qui commencerait
  // par « @nom ( » serait comptée comme une entrée, et toute synchronisation suivante refusée.
  it('un résumé à plusieurs paragraphes s’écrit sur une ligne, et le .bib produit se relit en entier', async () => {
    const library = lib();
    library.contents.ARTICLE[0].data.abstractNote =
      'Premier paragraphe.\n@WW1_live (2014) est un compte.\r\n\r\n@archives{x, deuxième\u2028@musee (2020) troisième.';
    const sync = new ZoteroSynchronizer(source(library));
    const first = applied(await sync.synchronize({ local: [], collectionKey: 'ARTICLE' }));

    const line = first.bibtex.split(/\r\n|\r|\n|\u2028|\u2029/).find((l) => l.trimStart().startsWith('abstract ='));
    // La virgule finale dépend de la place du champ dans l'entrée.
    expect(line?.replace(/,$/, '')).toBe(
      '  abstract = {Premier paragraphe. @WW1\\_live (2014) est un compte. @archives\\{x, deuxième @musee (2020) troisième.}'
    );
    expect(auditParsedBib(first.bibtex, reread(first)).unreadKeys).toEqual([]);
  });
});
