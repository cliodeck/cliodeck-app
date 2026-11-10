/**
 * Analyses de thèmes et enfants de `pdf_documents` (L02-10).
 *
 * - S01-1-15 : `saveTopicAnalysis` écrivait hors transaction. Un document retiré pendant le calcul
 *   (plusieurs minutes, dans le processus Python) faisait lever l'insertion de son affectation
 *   (`FOREIGN KEY constraint failed`) au milieu de la boucle, après que l'analyse précédente avait
 *   cessé d'être courante : il restait une analyse « courante » tronquée.
 * - S01-1-5 : `mergeDocumentsInto` (chaque « Ré-indexer ») rattachait citations et collections au
 *   document gardé, pas les affectations de thèmes : la cascade les emportait, et le PDF réindexé
 *   sortait de son thème et de la frise.
 * - S01-1-4 : `saveDocument` faisait `INSERT OR REPLACE` sur `pdf_documents`, dont REPLACE
 *   supprime la ligne, et avec elle, par cascade, extraits, citations, collections…
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteAvailable } from '@backend/__tests__/helpers/native-guards';
import Database from 'better-sqlite3';
import { VectorStore } from '../core/vector-store/VectorStore';
import { PDFIndexer } from '../core/pdf/PDFIndexer';
import type { PDFDocument } from '../types/pdf-document';
import type { TopicAnalysisResult } from '../core/analysis/TopicModelingService';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function doc(id: string, year = '2020'): PDFDocument {
  const date = new Date('2026-11-01T10:00:00Z');
  return {
    id,
    fileURL: `/projet/PDFs/${id}.pdf`,
    title: id,
    year,
    pageCount: 1,
    metadata: {},
    createdAt: date,
    indexedAt: date,
    lastAccessedAt: date,
    get displayString() {
      return this.title;
    },
  };
}

/** Résultat tel que le rend le service Python : `size` = nombre de documents du thème. */
function analysis(topics: Record<number, string[]>, outliers: string[] = [], keyword = 'mot'): TopicAnalysisResult {
  const topicAssignments: Record<string, number> = {};
  for (const [id, docs] of Object.entries(topics)) {
    for (const d of docs) topicAssignments[d] = Number(id);
  }
  const inTopics = Object.keys(topicAssignments).length;
  return {
    topics: Object.entries(topics).map(([id, docs]) => ({
      id: Number(id),
      label: `${keyword} ${id}`,
      keywords: [`${keyword}${id}`, 'histoire'],
      documents: docs,
      size: docs.length,
    })),
    topicAssignments,
    outliers,
    statistics: {
      totalDocuments: inTopics + outliers.length,
      numTopics: Object.keys(topics).length,
      numOutliers: outliers.length,
      numDocumentsInTopics: inTopics,
    },
  };
}

const TEXT =
  'Digital history requires historians to reflect on the transformations their tools impose on sources. ' +
  'Each software layer rewrites the source like a palimpsest, and the historian must document every layer carefully. ';
const extract = async () => ({
  pages: [{ pageNumber: 1, text: TEXT.repeat(8) }],
  metadata: {},
  title: 'Digital Doping for Historians',
});
async function embed(content: string): Promise<Float32Array> {
  const v = new Float32Array(8);
  for (let i = 0; i < content.length; i++) v[i % 8] += content.charCodeAt(i) / 1000;
  return v;
}
const indexer = (store: VectorStore) => new PDFIndexer(store, embed, 'cpuOptimized', undefined, false, {}, extract);

describe.skipIf(!sqliteAvailable)('analyses de thèmes et enfants de pdf_documents', () => {
  let dir: string;
  let store: VectorStore;
  const dbFile = () => path.join(dir, '.cliodeck', 'brain.db');

  /** Lecture directe de brain.db, par une autre connexion. */
  function query<T>(sql: string, ...params: string[]): T[] {
    const db = new Database(dbFile(), { readonly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  function loaded() {
    const result = store.loadLatestTopicAnalysis();
    if (!result) throw new Error('aucune analyse courante');
    return result;
  }

  /** Thèmes chargés, documents triés : ce que montrent la liste des thèmes et leur filtre. */
  function topicsShown() {
    return loaded().topics.map((t) => ({ id: t.id, size: t.size, documents: [...t.documents].sort() }));
  }

  /** Documents comptés par la frise, tous thèmes et toutes années confondus. */
  function timelineCount(): number {
    return (store.getTopicTimeline() ?? []).reduce(
      (sum, row) =>
        sum + Object.entries(row).reduce((s, [key, n]) => (key === 'year' ? s : s + Number(n)), 0),
      0
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-analysis-'));
    store = new VectorStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('enregistrer une analyse (S01-1-15)', () => {
    it('un document retiré pendant le calcul : l’analyse s’enregistre sans lui, courante et complète', () => {
      for (const id of ['a', 'b', 'c', 'd', 'e']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b', 'c'] }, ['d', 'e'], 'ancien'));

      // Le calcul a vu c et e ; ils sont retirés (réindexés sous un autre id, ou supprimés)
      // avant l'enregistrement.
      const result = analysis({ 0: ['a', 'c'], 1: ['b', 'd'] }, ['e'], 'nouveau');
      store.deleteDocument('c');
      store.deleteDocument('e');

      expect(() => store.saveTopicAnalysis(result, { nrTopics: 2 })).not.toThrow();

      const current = loaded();
      expect(current.topics.map((t) => t.label)).toEqual(['nouveau 0', 'nouveau 1']);
      expect(current.topicAssignments).toEqual({ a: 0, b: 1, d: 1 });
      expect(current.outliers).toEqual([]);
      // Taille du thème cohérente avec ses documents.
      expect(topicsShown()).toEqual([
        { id: 0, size: 1, documents: ['a'] },
        { id: 1, size: 2, documents: ['b', 'd'] },
      ]);
      expect(timelineCount()).toBe(3);
      // La précédente n'est plus courante ; une seule l'est.
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_analyses')[0].n).toBe(2);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_analyses WHERE is_current = 1')[0].n).toBe(1);
    });

    it('un thème dont tous les documents ont disparu n’est pas enregistré', () => {
      for (const id of ['a', 'b', 'c', 'd']) store.saveDocument(doc(id));
      const result = analysis({ 0: ['a', 'b'], 1: ['c', 'd'] });
      store.deleteDocument('c');
      store.deleteDocument('d');

      store.saveTopicAnalysis(result);

      // Ni carte « 0 documents », ni entrée de filtre qui ne montrerait rien ; la frise ne le
      // connaît pas non plus.
      expect(topicsShown()).toEqual([{ id: 0, size: 2, documents: ['a', 'b'] }]);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topics')[0].n).toBe(1);
      const timeline = store.getTopicTimeline() ?? [];
      expect(timeline.flatMap((row) => Object.keys(row).filter((k) => k !== 'year'))).toEqual(['topic_0']);
      expect(timelineCount()).toBe(2);
    });

    it('aucun document du résultat n’est encore là : rien n’est enregistré, la précédente reste courante', () => {
      // La route réelle : un autre projet ouvert pendant le calcul (S03-1-21, L03-7). Le résultat
      // du projet A arrive dans le brain.db de B, où aucun de ses documents n'existe.
      for (const id of ['b1', 'b2', 'b3']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['b1', 'b2', 'b3'] }, [], 'B'));

      const fromA = analysis({ 0: ['a1', 'a2'], 1: ['a3', 'a4'] }, ['a5'], 'A');
      expect(() => store.saveTopicAnalysis(fromA)).toThrow(/none of its 5 documents/);

      expect(loaded().topics.map((t) => t.label)).toEqual(['B 0']);
      expect(loaded().topicAssignments).toEqual({ b1: 0, b2: 0, b3: 0 });
      expect(loaded().statistics.totalDocuments).toBe(3);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_analyses')[0].n).toBe(1);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topics')[0].n).toBe(1);
      expect(timelineCount()).toBe(3);
    });

    it('une erreur au milieu de l’écriture laisse la précédente courante : tout ou rien', () => {
      for (const id of ['a', 'b', 'c']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b', 'c'] }, [], 'ancien'));

      // Panne SQLite réelle au moment d'écrire les aberrants, après l'analyse, ses thèmes et ses
      // affectations (disque plein, base verrouillée…).
      const db = new Database(dbFile());
      db.exec(`CREATE TRIGGER panne BEFORE INSERT ON pdf_topic_outliers BEGIN SELECT RAISE(ABORT, 'disque plein'); END`);
      db.close();

      expect(() => store.saveTopicAnalysis(analysis({ 0: ['a'], 1: ['b'] }, ['c'], 'nouveau'))).toThrow(/disque plein/);

      expect(loaded().topics.map((t) => t.label)).toEqual(['ancien 0']);
      expect(loaded().topicAssignments).toEqual({ a: 0, b: 0, c: 0 });
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_analyses')[0].n).toBe(1);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topics')[0].n).toBe(1);
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_assignments')[0].n).toBe(3);
    });

    it('témoin : une analyse sans document disparu s’enregistre comme avant, à l’identique', () => {
      for (const id of ['a', 'b', 'c', 'd', 'e']) store.saveDocument(doc(id));
      const result = analysis({ 1: ['c', 'e'], 0: ['a', 'b'] }, ['d']);

      store.saveTopicAnalysis(result, { nrTopics: 2, language: 'french' });

      const current = loaded();
      expect(current.topicAssignments).toEqual(result.topicAssignments);
      expect(current.outliers).toEqual(['d']);
      expect(current.statistics).toEqual(result.statistics);
      expect(current.options).toEqual({ nrTopics: 2, language: 'french' });
      expect(
        query<{ topic_id: number; label: string; keywords_json: string; size: number }>(
          'SELECT topic_id, label, keywords_json, size FROM pdf_topics ORDER BY topic_id'
        )
      ).toEqual([
        { topic_id: 0, label: 'mot 0', keywords_json: '["mot0","histoire"]', size: 2 },
        { topic_id: 1, label: 'mot 1', keywords_json: '["mot1","histoire"]', size: 2 },
      ]);
      expect(timelineCount()).toBe(4);
    });
  });

  describe('fondre des copies (S01-1-5)', () => {
    it('analyse sur a et b, a fondu dans a2 : le thème contient a2 et b, la frise compte deux documents', () => {
      for (const id of ['a', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'] }));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a']);

      expect(topicsShown()).toEqual([{ id: 0, size: 2, documents: ['a2', 'b'] }]);
      expect(loaded().topicAssignments).toEqual({ a2: 0, b: 0 });
      expect(timelineCount()).toBe(2);
    });

    it('un aberrant fondu reste aberrant sous le document gardé', () => {
      for (const id of ['a', 'b', 'c']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['b', 'c'] }, ['a']));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a']);

      expect(loaded().outliers).toEqual(['a2']);
    });

    it('deux copies de la même analyse fondues dans un nouveau document : une seule affectation', () => {
      for (const id of ['a', 'a-copie', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'], 1: ['a-copie'] }));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a', 'a-copie']);

      const rows = query<{ topic_id: number }>('SELECT topic_id FROM pdf_topic_assignments WHERE document_id = ?', 'a2');
      expect(rows).toHaveLength(1);
      expect(loaded().topicAssignments.a2).toBe(rows[0].topic_id);
      // Quelle copie l'emporte dépend de MIN(id) ; dans les deux cas, chaque thème affiché annonce
      // autant de documents qu'il en liste, et aucun n'est vide.
      for (const topic of topicsShown()) {
        expect(topic.size).toBe(topic.documents.length);
        expect(topic.size).toBeGreaterThan(0);
      }
    });

    it('deux copies dans le même thème : la taille du thème suit sa liste', () => {
      for (const id of ['a', 'a-copie', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'a-copie', 'b'] }));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a', 'a-copie']);

      expect(topicsShown()).toEqual([{ id: 0, size: 2, documents: ['a2', 'b'] }]);
      expect(timelineCount()).toBe(2);
    });

    it('deux copies dans deux thèmes : chaque thème garde une taille égale à sa liste', () => {
      for (const id of ['a', 'a-copie', 'b', 'c']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'], 1: ['a-copie', 'c'] }));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a', 'a-copie']);

      const shown = topicsShown();
      expect(shown).toHaveLength(2);
      for (const topic of shown) expect(topic.size).toBe(topic.documents.length);
      expect(shown.reduce((n, t) => n + t.size, 0)).toBe(3);
      expect(timelineCount()).toBe(3);
    });

    it('les tailles des analyses précédentes suivent aussi', () => {
      for (const id of ['a', 'a-copie', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'a-copie', 'b'] }, [], 'ancien'));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'] }, ['a-copie'], 'nouveau'));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a', 'a-copie']);

      expect(
        query<{ label: string; size: number }>('SELECT label, size FROM pdf_topics ORDER BY label')
      ).toEqual([
        { label: 'ancien 0', size: 2 },
        { label: 'nouveau 0', size: 2 },
      ]);
    });

    it('une copie affectée et une copie aberrante : le document gardé est affecté, jamais les deux', () => {
      for (const id of ['a', 'a-copie', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'] }, ['a-copie']));
      store.saveDocument(doc('a2'));

      store.mergeDocumentsInto('a2', ['a', 'a-copie']);

      expect(loaded().topicAssignments).toEqual({ a2: 0, b: 0 });
      expect(loaded().outliers).toEqual([]);
    });

    it('le document gardé figure déjà dans l’analyse : il garde sa place, ses copies partent', () => {
      for (const id of ['a', 'a-copie', 'b']) store.saveDocument(doc(id));
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'], 1: ['a-copie'] }));

      store.mergeDocumentsInto('a', ['a-copie']);

      expect(loaded().topicAssignments).toEqual({ a: 0, b: 0 });
      expect(query<{ n: number }>('SELECT COUNT(*) AS n FROM pdf_topic_assignments WHERE document_id = ?', 'a')[0].n).toBe(1);
      // Le thème 1 ne contenait que la copie : vidé, il n'est plus affiché (ni carte « 0 documents »,
      // ni entrée de filtre qui ne montrerait rien), comme à l'enregistrement.
      expect(topicsShown()).toEqual([{ id: 0, size: 2, documents: ['a', 'b'] }]);
    });

    it('« Ré-indexer » de bout en bout : le PDF réindexé reste dans son thème et dans la frise', async () => {
      const fileA = '/projet/PDFs/Kansteiner_2022.pdf';
      const meta = { title: 'Digital Doping for Historians', author: 'Kansteiner, Wulf', year: '2022' };
      const first = await indexer(store).indexPDF(fileA, 'Kansteiner_2022', undefined, meta);
      const other = await indexer(store).indexPDF('/projet/PDFs/Autre_2020.pdf', 'Autre_2020', undefined, {
        ...meta,
        year: '2020',
      });
      store.saveTopicAnalysis(analysis({ 0: [first.id, other.id] }));

      const second = await indexer(store).indexPDF(fileA, 'Kansteiner_2022', undefined, meta);

      expect(second.id).not.toBe(first.id);
      expect(store.getDocument(first.id)).toBeNull();
      expect(loaded().topicAssignments).toEqual({ [second.id]: 0, [other.id]: 0 });
      expect(topicsShown()).toEqual([{ id: 0, size: 2, documents: [second.id, other.id].sort() }]);
      expect(timelineCount()).toBe(2);
    });
  });

  describe('réenregistrer un document (S01-1-4)', () => {
    it('saveDocument sur un id existant le met à jour et garde extraits, citations, collections, similarités et thèmes', () => {
      for (const id of ['a', 'b', 'citant']) store.saveDocument(doc(id));
      store.saveChunk(
        { id: 'a-0', documentId: 'a', content: 'texte', pageNumber: 1, chunkIndex: 0, startPosition: 0, endPosition: 5 },
        new Float32Array(8).fill(1)
      );
      store.saveCitation({ id: 'sortante', sourceDocId: 'a', targetCitation: 'b 2020', targetDocId: 'b' });
      store.saveCitation({ id: 'entrante', sourceDocId: 'citant', targetCitation: 'a 2020', targetDocId: 'a' });
      store.saveCollections([{ key: 'COLL1', name: 'Forge' }]);
      store.setDocumentCollections('a', ['COLL1']);
      store.saveSimilarity('a', 'b', 0.9);
      store.saveTopicAnalysis(analysis({ 0: ['a', 'b'] }));

      store.saveDocument({ ...doc('a', '2021'), title: 'Titre corrigé', bibtexKey: 'A_2021' });

      expect(store.getDocument('a')).toMatchObject({ title: 'Titre corrigé', year: '2021', bibtexKey: 'A_2021' });
      expect(store.getChunksForDocument('a')).toHaveLength(1);
      expect(store.getCitationsForDocument('a')).toHaveLength(1);
      expect(store.getCitationsForDocument('citant')[0]).toMatchObject({ targetDocId: 'a' });
      expect(store.getDocumentCollections('a')).toEqual(['COLL1']);
      expect(store.getSimilarDocuments('a')).toEqual([{ documentId: 'b', similarity: 0.9 }]);
      expect(loaded().topicAssignments).toEqual({ a: 0, b: 0 });
    });
  });
});
