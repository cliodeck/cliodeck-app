/**
 * Collections Zotero d'un projet : hiérarchie, liens et rattachement des
 * documents indexés après la synchronisation (#130).
 *
 * Mesuré sur un projet réel (collection « 07 AI », 23 sous-collections,
 * 262 PDF) :
 *   - premier import puis indexation : **0 lien** document ↔ collection — le
 *     filtre par collection de l'assistant ne trouvait plus rien ;
 *   - 152 collections enregistrées, toute la bibliothèque ;
 *   - une seconde synchronisation laissait 67 collections « sans parent » au
 *     lieu d'une vingtaine de racines (INSERT OR REPLACE + ON DELETE SET NULL).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import { VectorStore } from '../core/vector-store/VectorStore';
import { PDFIndexer } from '../core/pdf/PDFIndexer';
import { collectionsForProject } from '../integrations/zotero/projectCollections';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FILE = '/projet/PDFs/Kansteiner_2022.pdf';
const META = { title: 'Digital Doping for Historians', author: 'Kansteiner, Wulf', year: '2022' };
const TEXT =
  'Digital history requires historians to reflect on the transformations their tools impose on sources. ' +
  'Each software layer rewrites the source like a palimpsest, and the historian must document every layer carefully. ';

const extract = async () => ({
  pages: [{ pageNumber: 1, text: TEXT.repeat(8) }],
  metadata: {},
  title: META.title,
});
async function embed(content: string): Promise<Float32Array> {
  const v = new Float32Array(8);
  for (let i = 0; i < content.length; i++) v[i % 8] += content.charCodeAt(i) / 1000;
  return v;
}
const indexer = (store: VectorStore) => new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);

// Arbre : AI > teaching > Teaching History AU ; Ailleurs (hors projet).
const AI = { key: 'AI', name: '07 AI' };
const TEACHING = { key: 'TEACH', name: 'teaching', parentKey: 'AI' };
const TH_AU = { key: 'THAU', name: 'Teaching History AU', parentKey: 'TEACH' };

describe.skipIf(!sqliteAvailable)('collections Zotero d’un projet', () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-collections-'));
    store = new VectorStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('une seconde synchronisation garde la hiérarchie et les liens, quel que soit l’ordre des collections', async () => {
    store.saveCollections([AI, TEACHING, TH_AU]);
    const document = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    store.setDocumentCollections(document.id, ['AI', 'THAU']);

    // Zotero ne garantit pas l'ordre : un enfant peut précéder son parent.
    store.saveCollections([TH_AU, TEACHING, AI]);

    const byKey = new Map(store.getAllCollections().map((c) => [c.key, c]));
    expect(byKey.get('THAU')?.parentKey).toBe('TEACH');
    expect(byKey.get('TEACH')?.parentKey).toBe('AI');
    expect(store.getDocumentCollections(document.id).sort()).toEqual(['AI', 'THAU']);
    // Le filtre récursif sur « 07 AI » atteint encore la sous-sous-collection.
    expect(store.getDocumentIdsInCollections(['AI'])).toEqual([document.id]);
  });

  it('un PDF indexé après la synchronisation est rattaché aux collections de sa référence', async () => {
    store.replaceCollections([AI, TEACHING, TH_AU]);
    store.replaceCollectionMemberships({ Kansteiner_2022: ['THAU'] });

    const document = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    expect(store.linkDocumentFromMemberships(document.id, document.bibtexKey)).toBe(1);

    expect(store.getDocumentCollections(document.id)).toEqual(['THAU']);
    expect(store.getDocumentIdsInCollections(['AI'])).toEqual([document.id]);
  });

  it('une référence absente de la dernière synchronisation ne perd pas ses liens', async () => {
    store.replaceCollections([AI]);
    const document = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    store.setDocumentCollections(document.id, ['AI']);
    store.replaceCollectionMemberships({ Autre_2020: ['AI'] });

    expect(store.linkDocumentFromMemberships(document.id, document.bibtexKey)).toBe(0);
    expect(store.getDocumentCollections(document.id)).toEqual(['AI']);
  });

  it('replaceCollections retire les collections hors projet et garde les liens des autres', async () => {
    const ailleurs = { key: 'ELSE', name: '02 Banquiers centraux' };
    store.replaceCollections([AI, TEACHING, TH_AU, ailleurs]);
    const document = await indexer(store).indexPDF(FILE, 'Kansteiner_2022', undefined, META);
    store.setDocumentCollections(document.id, ['THAU', 'ELSE']);

    store.replaceCollections([TH_AU, TEACHING, AI]);

    expect(store.getAllCollections().map((c) => c.key).sort()).toEqual(['AI', 'TEACH', 'THAU']);
    expect(store.getDocumentCollections(document.id)).toEqual(['THAU']);
  });
});

describe('collectionsForProject', () => {
  const all = [
    AI,
    TEACHING,
    TH_AU,
    { key: 'BIBLIOS', name: '09 Biblios articles' },
    { key: 'JGH', name: '2026_JGH', parentKey: 'BIBLIOS' },
    { key: 'COVID', name: '00 #covid19' },
    { key: 'RGB', name: 'RGB', parentKey: 'COVID' },
  ];

  it('garde l’arbre du projet, les collections portées par ses notices et leurs ancêtres — rien d’autre', () => {
    const kept = collectionsForProject(all, 'AI', { Hughes_2025: ['JGH', 'THAU'] });
    expect(kept.map((c) => c.key).sort()).toEqual(['AI', 'BIBLIOS', 'JGH', 'TEACH', 'THAU']);
  });

  it('sans collection de projet, garde les collections des notices et leurs ancêtres', () => {
    const kept = collectionsForProject(all, undefined, { X: ['RGB'] });
    expect(kept.map((c) => c.key).sort()).toEqual(['COVID', 'RGB']);
  });

  it('ignore une collection inconnue et ne boucle pas sur un cycle', () => {
    const cyclic = [
      { key: 'A', name: 'A', parentKey: 'B' },
      { key: 'B', name: 'B', parentKey: 'A' },
    ];
    expect(collectionsForProject(cyclic, 'A', { X: ['INCONNUE'] }).map((c) => c.key).sort()).toEqual(['A', 'B']);
  });
});
