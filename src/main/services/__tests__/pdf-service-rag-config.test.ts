/**
 * Le découpage, le filtrage et le résumé se figent dans l'indexeur à sa construction. Seul `init` le
 * construisait, et seul `config:set('llm')` appelle `init` : un changement limité à la section `rag`
 * ne prenait donc effet qu'à la réouverture du projet, sans erreur, alors que l'auteur venait de lire
 * « Configuration sauvegardée ».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RAGConfig } from '../../../../backend/types/config.js';

const state = vi.hoisted(() => ({
  rag: {} as Record<string, unknown>,
  indexers: [] as Array<{ ragConfig: Record<string, unknown>; summarizerConfig: unknown; indexPDF: ReturnType<typeof vi.fn> }>,
  store: { close: vi.fn(), countDuplicateDocuments: () => 0 },
  create: vi.fn(),
  configureEnhanced: vi.fn(),
  dispose: vi.fn(async () => undefined),
  buildRegistry: vi.fn(),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaChatModel: 'gemma2:2b' }),
    getRAGConfig: () => state.rag,
    get: () => state.rag,
  },
}));
vi.mock('../retrieval-service.js', () => ({ retrievalService: { configure: vi.fn() } }));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: state.buildRegistry,
}));
vi.mock('../pdf/PdfVectorStore.js', () => ({
  PdfVectorStore: {
    create: state.create,
    configureEnhanced: state.configureEnhanced,
    maybeRebuild: async () => undefined,
  },
}));
vi.mock('../pdf/PdfIndexer.js', () => ({
  PdfIndexer: class {
    ragConfig: Record<string, unknown>;
    summarizerConfig: unknown;
    indexPDF = vi.fn(async () => ({ id: 'doc' }));
    constructor(deps: { ragConfig: Record<string, unknown>; summarizerConfig: unknown }) {
      this.ragConfig = deps.ragConfig;
      this.summarizerConfig = deps.summarizerConfig;
      state.indexers.push(this);
    }
  },
}));

const { pdfService } = await import('../pdf-service.js');

beforeEach(async () => {
  await pdfService.close();
  vi.clearAllMocks();
  state.indexers.length = 0;
  state.rag = { chunkingConfig: 'cpuOptimized', topK: 10 } satisfies Partial<RAGConfig>;
  state.create.mockImplementation(() => ({ store: state.store, useEnhanced: true, initPromise: undefined }));
  state.buildRegistry.mockImplementation(() => ({
    getLLM: () => ({}),
    getEmbedding: () => ({ embed: async () => [[0.1]] }),
    dispose: state.dispose,
  }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('applyRagConfig', () => {
  it('l’indexation qui suit lit le nouveau découpage', async () => {
    await pdfService.init('/projet');
    expect(state.indexers.map((i) => i.ragConfig.chunkingConfig)).toEqual(['cpuOptimized']);

    state.rag = { ...state.rag, chunkingConfig: 'large' };
    pdfService.applyRagConfig();
    await pdfService.indexPDF('/projet/a.pdf');

    expect(state.indexers.map((i) => i.ragConfig.chunkingConfig)).toEqual(['cpuOptimized', 'large']);
    expect(state.indexers[0].indexPDF).not.toHaveBeenCalled();
    expect(state.indexers[1].indexPDF).toHaveBeenCalledTimes(1);
  });

  it('le résumé aussi : il se lit au même endroit', async () => {
    await pdfService.init('/projet');

    state.rag = { ...state.rag, summaryGeneration: 'disabled' };
    pdfService.applyRagConfig();

    expect(state.indexers[1].summarizerConfig).toMatchObject({ enabled: false });
  });

  it('ne relance rien : ni magasin fermé, ni fournisseurs refaits', async () => {
    await pdfService.init('/projet');
    state.store.close.mockClear();

    state.rag = { ...state.rag, chunkingConfig: 'large' };
    pdfService.applyRagConfig();

    expect(state.store.close).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.buildRegistry).toHaveBeenCalledTimes(1);
    expect(state.dispose).not.toHaveBeenCalled();
  });

  it('une section identique ne reconstruit rien, même rendue par un autre objet', async () => {
    await pdfService.init('/projet');

    state.rag = { ...state.rag };
    pdfService.applyRagConfig();

    expect(state.indexers).toHaveLength(1);
    expect(state.configureEnhanced).toHaveBeenCalledTimes(1);
  });

  it('le mode de recherche suit, sur le magasin ouvert', async () => {
    await pdfService.init('/projet');

    state.rag = { ...state.rag, useHybridSearch: false };
    pdfService.applyRagConfig();

    expect(state.configureEnhanced).toHaveBeenLastCalledWith(state.store, state.rag);
  });

  it('une indexation en vol finit avec l’indexeur qu’elle a', async () => {
    await pdfService.init('/projet');
    let finish = (_value: { id: string }): void => undefined;
    state.indexers[0].indexPDF.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const job = pdfService.indexPDF('/projet/a.pdf');

    state.rag = { ...state.rag, chunkingConfig: 'large' };
    pdfService.applyRagConfig();
    await pdfService.indexPDF('/projet/b.pdf');
    finish({ id: 'a' });
    await job;

    expect(state.indexers[0].indexPDF).toHaveBeenCalledTimes(1);
    expect(state.indexers[1].indexPDF).toHaveBeenCalledTimes(1);
  });

  it('sans projet ouvert, ou services à l’arrêt : rien à faire, `init` relira la section', async () => {
    expect(() => pdfService.applyRagConfig()).not.toThrow();
    expect(state.indexers).toHaveLength(0);

    await pdfService.init('/projet');
    state.buildRegistry.mockImplementation(() => {
      throw new Error('pas de clé');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(pdfService.init('/projet')).rejects.toThrow('pas de clé');

    state.rag = { ...state.rag, chunkingConfig: 'large' };
    expect(() => pdfService.applyRagConfig()).not.toThrow();
    expect(state.indexers).toHaveLength(1);
  });

  it('`init` relit la section : un Enregistrer qui écrit rag et llm n’a pas à le faire deux fois', async () => {
    await pdfService.init('/projet');

    state.rag = { ...state.rag, chunkingConfig: 'large' };
    await pdfService.init('/projet');
    pdfService.applyRagConfig();

    expect(state.indexers.map((i) => i.ragConfig.chunkingConfig)).toEqual(['cpuOptimized', 'large']);
  });
});
