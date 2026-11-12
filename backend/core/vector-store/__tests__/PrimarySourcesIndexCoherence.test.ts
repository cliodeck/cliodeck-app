/**
 * Les index en mémoire des sources primaires suivent la base (L06-6).
 *
 * - BM25 recevait chaque extrait sous forme de chaîne : `natural` la redécoupait avec son propre
 *   tokeniseur, qui coupe un mot sur chaque lettre accentuée (« préfet » → « pr », « fet »), alors
 *   que la requête gardait « préfet ». Aucun mot accentué n'était trouvé en lexical : « Pétain »,
 *   « préfet », « grève » (S02-1-1). Le bonus « mot exact » lisait une sous-chaîne : « Comment… »
 *   doublait le score d'un extrait qui écrit « commentaire ».
 * - `deleteChunks` ne retirait que les lignes de la base : BM25 servait encore le texte des
 *   extraits supprimés, une transcription corrigée sous son ancienne lecture (S08-1-22).
 * - Les points des extraits retirés restaient dans le graphe HNSW : la recherche dense en prenait
 *   ses candidats, puis les écartait, faute d'extrait en base. Une source réécrite de 200 extraits
 *   occupait toutes les places, et le nouvel extrait ne sortait plus.
 * - L'index s'écrivait en place : une écriture interrompue le laissait illisible, et tout était
 *   à reconstruire à la relance.
 *
 * Vrai magasin, vrai hnswlib, brain.db temporaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../__tests__/helpers/native-guards.js';
import { SPARSE_BASE } from '../../rag/relevance.js';
import { PrimarySourcesVectorStore, type PrimarySourceChunk } from '../PrimarySourcesVectorStore.js';

let tmp = '';
const opened: PrimarySourcesVectorStore[] = [];

function open(): PrimarySourcesVectorStore {
  const store = new PrimarySourcesVectorStore(tmp);
  opened.push(store);
  return store;
}

/** Un vecteur de 768 composantes, `weights` aux indices donnés, zéro ailleurs. */
function vector(weights: Record<number, number>): Float32Array {
  const v = new Float32Array(768);
  for (const [index, weight] of Object.entries(weights)) v[Number(index)] = weight;
  return v;
}

function addSource(store: PrimarySourcesVectorStore, id: string, title: string): void {
  store.saveSource({
    id,
    tropyId: Number(id.replace(/\D/g, '')) || 1,
    title,
    tags: [],
    photos: [],
    transcription: `Corps de ${title}.`,
    transcriptionSource: 'tesseract',
    lastModified: new Date('2026-05-06T13:13:22.394Z'),
    metadata: {},
  });
}

function chunk(sourceId: string, id: string, content: string, index = 0): PrimarySourceChunk {
  return { id, sourceId, content, chunkIndex: index, startPosition: 0, endPosition: content.length };
}

/**
 * `count` sources d'un extrait chacune, loin de toute question des tests (indices 600 et plus) :
 * un remplacement y fait moins de 10 % d'écart, la recherche ne reconstruit rien.
 */
function fillCorpus(store: PrimarySourcesVectorStore, count: number): void {
  for (let i = 1; i <= count; i++) {
    addSource(store, `src-${i}`, `Pièce ${i}`);
    store.replaceSourceChunks(`src-${i}`, [
      { chunk: chunk(`src-${i}`, `c${i}`, `[Doc: Pièce ${i}]\n\nregistre de la pièce ${i}`), embedding: vector({ [600 + i]: 1 }) },
    ]);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-primary-coherence-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      /* déjà fermé */
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — mots accentués en lexical (S02-1-1)', () => {
  /**
   * L'extrait cherché est orthogonal à la question en dense (cosinus 0) : sa pertinence publiée ne
   * vient que de son rang lexical, `SPARSE_BASE` au premier rang (Path A′).
   */
  function lexicalRelevance(store: PrimarySourcesVectorStore, query: string): number | undefined {
    return store.search(vector({ 700: 1 }), 30, query).find((r) => r.chunk.id === 'k1')?.similarity;
  }

  it('« Rapport du préfet sur la grève, signé Pétain à Marseille » : les quatre mots le trouvent', () => {
    const store = open();
    fillCorpus(store, 20);
    addSource(store, 'src-k', 'Rapport');
    store.replaceSourceChunks('src-k', [
      {
        chunk: chunk('src-k', 'k1', '[Doc: Rapport]\n\nRapport du préfet sur la grève, signé Pétain à Marseille'),
        embedding: vector({ 1: 1 }),
      },
    ]);

    for (const word of ['Marseille', 'Pétain', 'préfet', 'grève']) {
      expect(lexicalRelevance(store, word), word).toBe(SPARSE_BASE);
    }
  });

  it('une question tapée sans accents, ou en capitales, trouve aussi le mot accentué', () => {
    const store = open();
    fillCorpus(store, 20);
    addSource(store, 'src-k', 'Rapport');
    store.replaceSourceChunks('src-k', [
      {
        chunk: chunk('src-k', 'k1', '[Doc: Rapport]\n\nRapport du préfet sur la grève, signé Pétain à Marseille'),
        embedding: vector({ 1: 1 }),
      },
    ]);

    for (const word of ['Petain', 'prefet', 'greve', 'PÉTAIN']) {
      expect(lexicalRelevance(store, word), word).toBe(SPARSE_BASE);
    }
  });

  it('« Comment le port… » : le bonus « mot exact » ne vaut plus pour « commentaire »', () => {
    const store = open();
    addSource(store, 'src-1', 'Pièce A');
    addSource(store, 'src-2', 'Pièce B');
    // B est le plus proche en dense, A le second ; seul A contient un mot de la question (« port »).
    store.replaceSourceChunks('src-1', [
      { chunk: chunk('src-1', 'A', '[Doc: Pièce A]\n\nLe port de Marseille.'), embedding: vector({ 0: 1, 1: 0.6 }) },
    ]);
    store.replaceSourceChunks('src-2', [
      { chunk: chunk('src-2', 'B', '[Doc: Pièce B]\n\nCommentaire du préfet.'), embedding: vector({ 0: 1, 1: 0.2 }) },
    ]);

    // « Comment » est un mot-outil de question : il ne vaut aucun bonus, ni à « commentaire ».
    expect(store.search(vector({ 0: 1 }), 1, 'Comment le port')[0]?.chunk.id).toBe('A');
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — extraits supprimés retirés des index (S08-1-22)', () => {
  it('deleteChunks puis l’extrait corrigé : l’ancienne lecture « Mussolinj » ne sort plus', () => {
    const store = open();
    fillCorpus(store, 20);
    addSource(store, 'src-x', 'Note sur le Duce');
    store.replaceSourceChunks('src-x', [
      { chunk: chunk('src-x', 'old', '[Doc: Note sur le Duce]\n\nVieille lecture OCR erronée : Mussolinj'), embedding: vector({ 5: 1 }) },
    ]);

    // Le chemin de la synchro et de l'écriture d'une transcription : les extraits du texte changé
    // sont supprimés, puis la source est réembarquée.
    store.deleteChunks('src-x');
    store.replaceSourceChunks('src-x', [
      { chunk: chunk('src-x', 'new', '[Doc: Note sur le Duce]\n\nLecture corrigée : Mussolini'), embedding: vector({ 6: 1 }) },
    ]);

    const ids = store.search(vector({ 5: 1 }), 10, 'Mussolinj').map((r) => r.chunk.id);
    expect(ids).not.toContain('old');
    expect(store.search(vector({ 6: 1 }), 10, 'Mussolini').map((r) => r.chunk.id)).toContain('new');
  });

  it('une source de 200 extraits remplacée : les candidats denses ne sont pas des points supprimés, le nouvel extrait sort', () => {
    const store = open();
    addSource(store, 'src-1', 'Registre');
    // 200 extraits tout près de la question (cosinus 0,999), au-delà des 50 candidats de la recherche.
    store.replaceSourceChunks(
      'src-1',
      Array.from({ length: 200 }, (_, i) => ({
        chunk: chunk('src-1', `old-${i}`, `[Doc: Registre]\n\nancienne lecture ${i}`, i),
        embedding: vector({ 0: 1, [1 + i]: 0.05 }),
      }))
    );
    store.replaceSourceChunks('src-1', [
      { chunk: chunk('src-1', 'new', '[Doc: Registre]\n\nlecture corrigée'), embedding: vector({ 0: 1, 500: 1 }) },
    ]);

    expect(store.search(vector({ 0: 1 }), 10).map((r) => r.chunk.id)).toEqual(['new']);
  });

  it('les 200 extraits supprimés d’abord, le nouvel extrait ensuite (chemin de la synchro) : il sort de la recherche dense', () => {
    const store = open();
    addSource(store, 'src-1', 'Registre');
    store.replaceSourceChunks(
      'src-1',
      Array.from({ length: 200 }, (_, i) => ({
        chunk: chunk('src-1', `old-${i}`, `[Doc: Registre]\n\nancienne lecture ${i}`, i),
        embedding: vector({ 0: 1, [1 + i]: 0.05 }),
      }))
    );
    // La synchro supprime les extraits du texte changé, puis réembarque la source : le nouveau
    // point arrive dans un voisinage dont aucun point n'est plus servi.
    store.deleteChunks('src-1');
    store.replaceSourceChunks('src-1', [
      { chunk: chunk('src-1', 'new', '[Doc: Registre]\n\nlecture corrigée'), embedding: vector({ 0: 1, 500: 1 }) },
    ]);

    expect(store.search(vector({ 0: 1 }), 10).map((r) => r.chunk.id)).toEqual(['new']);
  });

  it('deleteSource : les extraits de la source ne prennent plus les places des candidats denses', () => {
    const store = open();
    addSource(store, 'src-1', 'Registre');
    addSource(store, 'src-2', 'Lettre');
    store.replaceSourceChunks(
      'src-1',
      Array.from({ length: 200 }, (_, i) => ({
        chunk: chunk('src-1', `old-${i}`, `[Doc: Registre]\n\nlecture ${i}`, i),
        embedding: vector({ 0: 1, [1 + i]: 0.05 }),
      }))
    );
    store.replaceSourceChunks('src-2', [
      { chunk: chunk('src-2', 'lettre', '[Doc: Lettre]\n\nla lettre'), embedding: vector({ 0: 1, 500: 1 }) },
    ]);

    store.deleteSource('src-1');

    expect(store.search(vector({ 0: 1 }), 10).map((r) => r.chunk.id)).toEqual(['lettre']);
  });

  it('purgeAll puis de nouveaux extraits : les anciens ne pèsent plus sur le classement lexical', () => {
    const store = open();
    // Avant la purge, cent extraits écrivent « Marseille », aucun « Toulon ».
    for (let i = 1; i <= 100; i++) {
      addSource(store, `old-${i}`, `Ancienne ${i}`);
      store.replaceSourceChunks(`old-${i}`, [
        { chunk: chunk(`old-${i}`, `o${i}`, `Marseille ${i}`), embedding: vector({ [600 + (i % 100)]: 1 }) },
      ]);
    }
    store.purgeAll();

    addSource(store, 'src-1', 'A');
    addSource(store, 'src-2', 'B');
    store.replaceSourceChunks('src-1', [
      { chunk: chunk('src-1', 'A', 'Marseille Marseille Marseille'), embedding: vector({ 1: 1 }) },
    ]);
    store.replaceSourceChunks('src-2', [{ chunk: chunk('src-2', 'B', 'Toulon et le reste'), embedding: vector({ 2: 1 }) }]);

    // Deux extraits, un mot chacun, aussi rare l'un que l'autre : celui qui le répète est premier en
    // lexical. Les cent extraits purgés rendaient « Marseille » banal, et « Toulon » passait devant.
    // La question est orthogonale aux deux en dense : la pertinence publiée est celle du rang lexical.
    const relevance = Object.fromEntries(
      store.search(vector({ 700: 1 }), 2, 'Marseille Toulon').map((r) => [r.chunk.id, r.similarity])
    );
    expect(relevance.A).toBe(SPARSE_BASE);
    expect(relevance.B).toBeLessThan(SPARSE_BASE);
  });
});

describe.skipIf(!sqliteAvailable)('PrimarySourcesVectorStore — index écrit sur disque', () => {
  function readMeta(): { currentSize: number; labelMap: Array<[number, string]> } {
    return JSON.parse(fs.readFileSync(path.join(tmp, '.cliodeck', 'primary-hnsw.index.meta.json'), 'utf-8'));
  }

  it('la méta compte les vecteurs servis, pas les points des extraits remplacés : pas de faux écart au bilan de santé', () => {
    const store = open();
    fillCorpus(store, 20);
    store.replaceSourceChunks('src-7', [
      { chunk: chunk('src-7', 'c7-new', '[Doc: Pièce 7]\n\nregistre corrigé'), embedding: vector({ 607: 1, 3: 1 }) },
    ]);
    store.close();

    // `project:health` compare `currentSize` au nombre d'extraits embarqués : 20.
    const meta = readMeta();
    expect(meta.currentSize).toBe(20);
    expect(meta.labelMap).toHaveLength(20);
  });

  it('les points des extraits retirés restent écartés à la relecture de l’index', () => {
    const first = open();
    addSource(first, 'src-1', 'Registre');
    first.replaceSourceChunks(
      'src-1',
      Array.from({ length: 200 }, (_, i) => ({
        chunk: chunk('src-1', `old-${i}`, `lecture ${i}`, i),
        embedding: vector({ 0: 1, [1 + i]: 0.05 }),
      }))
    );
    first.replaceSourceChunks('src-1', [{ chunk: chunk('src-1', 'new', 'lecture corrigée'), embedding: vector({ 0: 1, 500: 1 }) }]);
    first.close();

    const reopened = open();
    expect(reopened.search(vector({ 0: 1 }), 10).map((r) => r.chunk.id)).toEqual(['new']);
  });

  it('une écriture de l’index interrompue laisse le précédent intact : la relance n’a rien à reconstruire', () => {
    const first = open();
    fillCorpus(first, 20);
    first.close();

    const second = open();
    addSource(second, 'src-k', 'Rapport');
    second.replaceSourceChunks('src-k', [{ chunk: chunk('src-k', 'k1', 'rapport'), embedding: vector({ 1: 1 }) }]);
    // Le disque se remplit en pleine écriture : quelques octets écrits, puis l'erreur.
    const index = (second as unknown as { hnswIndex: { writeIndexSync(file: string): void } }).hnswIndex;
    vi.spyOn(index, 'writeIndexSync').mockImplementation((file: string) => {
      fs.writeFileSync(file, Buffer.alloc(64, 7));
      throw new Error('ENOSPC: no space left on device, write');
    });
    second.saveHNSWIndex();
    vi.mocked(index.writeIndexSync).mockRestore();
    // L'app tombe ensuite sans fermer le magasin.
    vi.spyOn(second, 'saveHNSWIndex').mockImplementation(() => undefined);
    second.close();

    const relaunched = open();
    // L'index d'avant, relu : seul l'extrait écrit depuis lui manque, et la recherche dense sert les autres.
    expect(relaunched.checkHnswIndex()).toMatchObject({ missing: 1, stale: 0 });
    expect(relaunched.search(vector({ 607: 1 }), 1)[0]?.chunk.id).toBe('c7');
    expect(fs.readdirSync(path.join(tmp, '.cliodeck')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('app tombée après deleteChunks, avant l’écriture de l’index : à la relance, les étiquettes des extraits supprimés ne servent plus', () => {
    const first = open();
    // 2 200 extraits servis, loin de la question : 200 points morts restent sous les 10 % de
    // `checkHnswIndex`, et rien ne se reconstruit à la relance.
    addSource(first, 'fill-1', 'Remplissage');
    first.replaceSourceChunks(
      'fill-1',
      Array.from({ length: 2200 }, (_, i) => ({
        chunk: chunk('fill-1', `f-${i}`, `remplissage ${i}`, i),
        embedding: vector({ [100 + (i % 600)]: 1, [700 + Math.floor(i / 600)]: 0.5 }),
      }))
    );
    addSource(first, 'src-1', 'Registre');
    first.replaceSourceChunks(
      'src-1',
      Array.from({ length: 200 }, (_, i) => ({
        chunk: chunk('src-1', `old-${i}`, `ancienne lecture ${i}`, i),
        embedding: vector({ 0: 1, [1 + i]: 0.05 }),
      }))
    );
    addSource(first, 'src-2', 'Lettre');
    first.replaceSourceChunks('src-2', [{ chunk: chunk('src-2', 'lettre', 'la lettre'), embedding: vector({ 0: 1, 250: 1 }) }]);
    first.close();

    // OCR manuel : `updateSourceTranscription` retire les extraits, et l'app tombe pendant
    // l'embarquement du nouveau texte, avant toute écriture de l'index.
    const second = open();
    second.deleteChunks('src-1');
    vi.spyOn(second, 'saveHNSWIndex').mockImplementation(() => undefined);
    second.close();

    // La méta relue étiquette encore les 200 extraits supprimés : leurs points ne doivent pas
    // prendre les 50 places des candidats denses.
    const relaunched = open();
    expect(relaunched.checkHnswIndex()).toMatchObject({ missing: 0, stale: 200, needsRebuild: false });
    // Le magasin rend `topK` extraits sans seuil : les extraits de remplissage (cosinus nul) suivent.
    expect(relaunched.search(vector({ 0: 1 }), 10)[0]?.chunk.id).toBe('lettre');

    // La source réembarquée (la synchro suivante la reprend) : son nouvel extrait sort dès la relance.
    relaunched.replaceSourceChunks('src-1', [
      { chunk: chunk('src-1', 'new', 'lecture corrigée'), embedding: vector({ 0: 1, 500: 1 }) },
    ]);
    const ids = relaunched.search(vector({ 0: 1 }), 10).map((r) => r.chunk.id);
    expect(ids.slice(0, 2).sort()).toEqual(['lettre', 'new']);
    relaunched.close();

    // `project:health` compare `currentSize` aux extraits embarqués : 2 202, sans faux écart.
    const meta = readMeta();
    expect(meta.currentSize).toBe(2202);
    expect(meta.labelMap.map(([, chunkId]) => chunkId)).not.toContain('old-0');
  });
});
