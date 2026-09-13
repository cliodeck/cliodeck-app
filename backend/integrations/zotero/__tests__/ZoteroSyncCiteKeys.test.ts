import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IZoteroDataSource } from '../IZoteroDataSource';
import type { ZoteroItem } from '../ZoteroAPI';
import { ZoteroSync } from '../ZoteroSync';
import { assignCiteKeys } from '../../../core/bibliography/citekey';
import { BibTeXExporter } from '../../../core/bibliography/BibTeXExporter';
import { createCitation } from '../../../types/citation';

/**
 * Un réimport réécrit `bibliography.bib` de fond en comble. Les clés que
 * l'auteur a écrites dans son texte doivent y survivre : sans cela, ajouter
 * un ouvrage dans Zotero suffit à repointer un `[@clef]` existant vers une
 * autre œuvre.
 *
 * La source de données est un double : `ZoteroLocalBibTeX` charge le binding
 * natif de better-sqlite3, que la suite Node ne peut pas ouvrir. On reproduit
 * ici son contrat — attribuer les clés avec `assignCiteKeys`, exporter avec
 * `BibTeXExporter` — pour éprouver le passage de témoin par `ZoteroSync`.
 */

function item(key: string, lastName: string, date: string, title: string): ZoteroItem {
  return {
    key,
    version: 0,
    library: { type: 'user', id: 1, name: '' },
    data: {
      key,
      version: 0,
      itemType: 'journalArticle',
      title,
      creators: [{ creatorType: 'author', lastName, firstName: 'A.' }],
      date,
      dateAdded: `${date}-01-01`,
    },
  } as ZoteroItem;
}

function fakeSource(items: ZoteroItem[], dropLast = false): IZoteroDataSource {
  const exporter = new BibTeXExporter();
  return {
    listCollections: async () => [],
    listSubcollections: async () => [],
    getCollection: async (key: string) =>
      ({ key, version: 0, library: {}, data: { key, name: 'Collection', version: 0 } }) as never,
    listItems: async () => items,
    getItem: async (key: string) => items.find((i) => i.key === key)!,
    getItemChildren: async () => [],
    getItemAttachments: async () => [],
    hasAttachments: async () => false,
    exportCollectionAsBibTeX: async (_key, _sub, preservedKeys) => {
      const keys = assignCiteKeys(items, new Set(), preservedKeys);
      // `dropLast` imite une perte silencieuse : c'est exactement ce que
      // fait l'export de l'API Zotero, qui déduplique par clé.
      const exported = dropLast ? items.slice(0, -1) : items;
      return exporter.exportToString(
        exported.map((i) =>
          createCitation({
            id: keys.get(i.key)!,
            type: 'article',
            author: i.data.creators?.[0]?.lastName ?? '',
            year: i.data.date ?? '',
            title: i.data.title ?? '',
            zoteroKey: i.key,
          })
        )
      );
    },
    exportAllAsBibTeX: async () => '',
    downloadFile: async () => ({ filename: '', size: 0 }),
    testConnection: async () => true,
    getItemMetadata: () => ({ title: '', authors: '', year: '', type: '' }),
  };
}

describe('ZoteroSync — clés du .bib entre deux imports', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-sync-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sync = (items: ZoteroItem[]) =>
    new ZoteroSync(fakeSource(items)).syncCollection({
      collectionKey: 'COLL',
      exportBibTeX: true,
      targetDirectory: dir,
    });

  it('ne déplace pas une clé déjà attribuée quand un homonyme arrive', async () => {
    const chapitre = item('CHAP', 'Fickers', '2022', 'Introduction');
    const first = await sync([chapitre]);
    expect(first.citeKeys).toEqual({ CHAP: 'Fickers_2022' });

    // Le livre a été ajouté à Zotero avant le chapitre : sans reconduction,
    // il raflerait la clé nue et le chapitre deviendrait `Fickers_2022a`.
    const livre = item('LIVRE', 'Fickers', '2022', 'Digital History and Hermeneutics');
    livre.data.dateAdded = '2020-01-01';

    const second = await sync([chapitre, livre]);
    expect(second.citeKeys.CHAP).toBe('Fickers_2022');
    expect(second.citeKeys.LIVRE).toBe('Fickers_2022a');
  });

  it('republie les mêmes clés quand rien ne change', async () => {
    const items = [
      item('AAA', 'Hutchinson', '2024', 'Mapping the Latent Past'),
      item('BBB', 'Hutchinson', '2024', 'Mapping the Latent Past (doublon Zotero)'),
    ];
    const first = await sync(items);
    const second = await sync(items);
    expect(second.citeKeys).toEqual(first.citeKeys);
    expect(new Set(Object.values(first.citeKeys)).size).toBe(2);
  });

  it('rapporte les clés réellement écrites dans le fichier', async () => {
    const result = await sync([item('AAA', 'Dupont', '2024', 'Un titre')]);
    const written = fs.readFileSync(path.join(dir, 'bibliography.bib'), 'utf-8');
    expect(written).toContain('@article{Dupont_2024,');
    expect(result.citeKeys).toEqual({ AAA: 'Dupont_2024' });
  });
});

describe('ZoteroSync — ce que l’import a le devoir de dire', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-zotero-warn-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sync = (items: ZoteroItem[], dropLast = false) =>
    new ZoteroSync(fakeSource(items, dropLast)).syncCollection({
      collectionKey: 'COLL',
      exportBibTeX: true,
      targetDirectory: dir,
    });

  it('se tait quand la collection et le fichier concordent', async () => {
    const result = await sync([
      item('AAA', 'Dupont', '2024', 'Un titre assez long pour compter'),
      item('BBB', 'Martin', '2023', 'Un autre titre bien distinct'),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });

  it('signale une notice qui n’a pas atteint le fichier', async () => {
    const result = await sync(
      [
        item('AAA', 'Dupont', '2024', 'Un titre assez long pour compter'),
        item('BBB', 'Martin', '2023', 'Un autre titre bien distinct'),
      ],
      true
    );
    expect(result.warnings).toEqual([{ kind: 'count-mismatch', expected: 2, written: 1 }]);
  });

  it('signale les œuvres en double sans les fusionner', async () => {
    const items = [
      item('AAA', 'Hutchinson', '2024', 'Mapping the Latent Past: Assessing LLMs'),
      item('BBB', 'Hutchinson', '2024', 'Mapping the latent past: assessing LLMs'),
    ];
    const result = await sync(items);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].keys).toEqual(['AAA', 'BBB']);
    // Les deux entrées sont bien écrites : c'est un signalement, pas un tri.
    expect(Object.keys(result.citeKeys)).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });
});
