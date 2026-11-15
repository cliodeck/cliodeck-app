/**
 * La toute première indexation d'un PDF : la bibliographie est « en indexation », pas « 0 » (E3).
 *
 * `PDFIndexer` calcule tous les embeddings d'un PDF avant d'écrire ses extraits, d'un bloc (L02-7).
 * Pendant ce temps, la bibliographie n'a aucun extrait, et la règle de H6 la faisait répondre « 0 »
 * sans la chercher. Le chat disait « Bibliographie 0 » et « Aucune source pertinente trouvée. », et
 * le modèle ne recevait aucune consigne : il pouvait conclure que la bibliographie se tait, alors
 * qu'un PDF était en train d'y entrer.
 *
 * Vrais `pdfService`, indexeur, magasin (`EnhancedVectorStore` sur un vrai `brain.db`) et
 * `retrievalService`. Simulés : l'extraction du PDF, et le fournisseur d'embeddings, qui retient ceux
 * du PDF comme un Ollama lent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));

const state = vi.hoisted(() => ({
  /** Les embeddings du PDF attendent cette promesse, quand elle est posée. */
  gate: null as Promise<void> | null,
  /** Les textes du PDF demandés au fournisseur, et ceux de la question. */
  pdfEmbeds: 0,
  questionEmbeds: 0,
  pdfMark: 'Kansteiner',
  questionMark: 'grève des dockers',
}));

/** 768, celle de nomic-embed-text ; des vecteurs positifs, tirés du texte, proches les uns des autres. */
function vectorOf(text: string): number[] {
  const v = new Array<number>(768).fill(0.01);
  for (let i = 0; i < text.length; i++) v[i % 768] += text.charCodeAt(i) / 1000;
  return v;
}

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({}),
      getEmbedding: () => ({
        id: 'fake-embed:premiere-indexation',
        embed: async (texts: string[]) => {
          const ofPdf = texts.some((text) => text.includes(state.pdfMark));
          for (const text of texts) {
            if (text.includes(state.pdfMark)) state.pdfEmbeds += 1;
            if (text.includes(state.questionMark)) state.questionEmbeds += 1;
          }
          if (ofPdf && state.gate) await state.gate;
          return texts.map(vectorOf);
        },
      }),
      dispose: async () => undefined,
    }),
  };
});

const TEXT =
  'Kansteiner rappelle que l’histoire numérique oblige l’historien à décrire chaque couche logicielle qui transforme ses sources. ' +
  'Les modèles entraînés sur des archives reproduisent les silences de ces archives, sauf correction explicite. ';

vi.mock('../pdf-extract-isolated.js', () => ({
  extractPdfIsolated: async () => ({
    ok: true,
    pages: [
      { pageNumber: 1, text: TEXT.repeat(6) },
      { pageNumber: 2, text: TEXT.repeat(6) },
    ],
    metadata: {},
    title: 'Digital Doping for Historians',
  }),
}));

import { configManager } from '../config-manager.js';
import { pdfService } from '../pdf-service.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';
import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';

const META = { title: 'Digital Doping for Historians', author: 'Kansteiner, Wulf', year: '2022' };

let project = '';
let turn = 0;
const question = (): string => `question ${++turn} sur la ${state.questionMark}`;

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000 && !condition(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(condition()).toBe(true);
}

/** Des embeddings du PDF qui attendent qu'on les relâche, ou qu'on les fasse échouer. */
function holdPdfEmbeddings(): { release: () => void; fail: (error: Error) => void } {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const gate = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  gate.catch(() => undefined);
  state.gate = gate;
  return {
    release: () => {
      state.gate = null;
      resolve();
    },
    fail: (error) => reject(error),
  };
}

const secondary = async () => {
  const { outcomes, stats } = await retrievalService.searchWithStats({ query: question(), sourceType: 'secondary' });
  return {
    outcome: outcomes.find((o) => o.source === 'secondary'),
    corpus: stats.search.corpora.find((c) => c.source === 'secondary'),
  };
};

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-premiere-indexation-'));
  state.pdfEmbeds = 0;
  state.questionEmbeds = 0;
  state.gate = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:9',
    ollamaChatModel: 'test',
    ollamaEmbeddingModel: 'nomic-embed-text',
  } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
    topK: 5,
    similarityThreshold: 0.12,
    chunkingConfig: 'cpuOptimized',
    enablePreprocessing: false,
    enableQualityFiltering: false,
    enableDeduplication: false,
  } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  await pdfService.init(project);
});

afterEach(async () => {
  state.gate = null;
  await pdfService.close();
  vi.restoreAllMocks();
  fs.rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('bibliographie pendant la toute première indexation d’un PDF (E3)', () => {
  it('« en indexation », sans embarquer la question ; puis le PDF répond', async () => {
    const { release } = holdPdfEmbeddings();
    const job = pdfService.indexPDF(path.join(project, 'Kansteiner_2022.pdf'), 'Kansteiner_2022', undefined, META);
    try {
      await until(() => state.pdfEmbeds > 0);

      const during = await secondary();
      expect(during.outcome).toMatchObject({ attempted: true, ok: false, indexing: true, hitCount: 0 });
      expect(during.corpus).toMatchObject({ ok: false, indexing: true });
      // Rien à chercher encore : la question n'est pas embarquée pour autant.
      expect(state.questionEmbeds).toBe(0);
      // Le magasin d'un autre projet n'est pas en indexation, lui.
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-premiere-indexation-autre-'));
      const other = new EnhancedVectorStore(elsewhere);
      try {
        expect(pdfService.isIndexingInto(other)).toBe(false);
      } finally {
        other.close();
        fs.rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      release();
    }
    await job;

    const after = await secondary();
    expect(after.outcome).toMatchObject({ attempted: true, ok: true });
    expect(after.outcome?.indexing).toBeUndefined();
    expect(after.outcome?.hitCount).toBeGreaterThan(0);
  });

  it('témoin : sans indexation en vol, une bibliographie vide rend 0, sans embarquer la question (H6)', async () => {
    const { outcome, corpus } = await secondary();
    expect(outcome).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(outcome?.indexing).toBeUndefined();
    expect(corpus?.indexing).toBeUndefined();
    expect(state.questionEmbeds).toBe(0);
  });

  it('témoin : une indexation qui échoue ne laisse pas la bibliographie « en indexation »', async () => {
    const { fail } = holdPdfEmbeddings();
    const job = pdfService.indexPDF(path.join(project, 'Kansteiner_2022.pdf'), 'Kansteiner_2022', undefined, META);
    await until(() => state.pdfEmbeds > 0);
    // Ollama s'arrête : l'embedding retenu échoue, l'indexation avec lui.
    fail(new Error('fetch failed'));
    await expect(job).rejects.toThrow('fetch failed');
    state.gate = null;

    const { outcome } = await secondary();
    expect(outcome).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(outcome?.indexing).toBeUndefined();
  });
});
