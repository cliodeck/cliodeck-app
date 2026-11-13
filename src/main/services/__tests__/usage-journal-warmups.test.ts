/**
 * Ouvrir un projet n'écrit rien au journal d'usage et n'envoie aucun texte sans raison (J11).
 *
 * L'ouverture d'un projet lançait deux préchauffages, et chacun s'inscrivait au journal comme un
 * appel de l'auteur :
 *  - `warmup query`, qui charge le modèle d'embeddings (`pdfService`). Il reste : la première
 *    question n'attend pas le chargement. Mais c'est un geste de l'app, sans conséquence
 *    méthodologique pour l'auteur : il sort du journal (décision de l'auteur, J11).
 *  - les 23 termes du dictionnaire d'expansion FR↔EN (`retrievalService`), embarqués un par un pour
 *    remplir le cache des requêtes. Ce cache ne sert qu'à une question réduite à un terme du
 *    dictionnaire : l'expansion embarque la question entière, réécrite. Ce sont des termes de
 *    pédagogie, un reste d'un autre domaine : ils ne partent plus (rien ne sort sans raison).
 *
 * Vrais `pdfService`, `retrievalService`, magasin des PDF, décorateur du journal, service du
 * journal et `journal.db` ; simulés : la configuration, le fournisseur d'embeddings derrière le
 * décorateur (il garde les textes reçus), l'indexeur des PDF et les corpus voisins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const state = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userdata-de-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {},
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({
      backend: 'ollama',
      ollamaURL: 'http://127.0.0.1:11434',
      ollamaChatModel: 'llama3.2',
      ollamaEmbeddingModel: 'nomic-embed-text',
    }),
    getRAGConfig: () => ({ topK: 5, similarityThreshold: 0.12, chunkingConfig: 'cpuOptimized' }),
    get: () => ({}),
  },
}));
vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async () => {
  const { instrumentEmbedding } = await import('../../../../backend/core/llm/providers/instrument.js');
  return {
    // Comme le vrai registre : un fournisseur Ollama local, enveloppé par le décorateur du journal.
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({}),
      getEmbedding: () =>
        instrumentEmbedding(
          {
            id: 'ollama-embedding',
            name: 'Ollama',
            model: 'nomic-embed-text',
            dimension: 8,
            getStatus: () => ({ state: 'ready' }),
            healthCheck: async () => ({ state: 'ready' }),
            dispose: async () => undefined,
            embed: async (texts: string[]) => {
              state.sent.push(...texts);
              return texts.map((t) => Array.from({ length: 8 }, (_, d) => ((t.length + d) % 5) / 5 + 0.1));
            },
          },
          'ollama',
          'http://127.0.0.1:11434'
        ),
      dispose: async () => undefined,
    }),
  };
});
vi.mock('../pdf/PdfIndexer.js', () => ({ PdfIndexer: class {} }));
vi.mock('../pdf-extract-isolated.js', () => ({ extractPdfIsolated: vi.fn() }));
vi.mock('../tropy-service.js', () => ({ tropyService: { search: vi.fn(async () => []) } }));
vi.mock('../manuscript-index-service.js', () => ({
  manuscriptIndexService: { configure: vi.fn(), clear: vi.fn(), isEnabled: () => false },
}));
vi.mock('../reading-notes-index-service.js', () => ({
  readingNotesIndexService: {
    configure: vi.fn(),
    clear: vi.fn(),
    isEnabled: () => false,
    getSearchStore: () => null,
  },
}));

const { pdfService } = await import('../pdf-service.js');
const { retrievalService } = await import('../retrieval-service.js');
const { usageJournalService } = await import('../usage-journal-service.js');
const { PdfVectorStore } = await import('../pdf/PdfVectorStore.js');
const { ACADEMIC_TERMS_FR_TO_EN } = await import(
  '../../../../backend/core/rag/retrievers/secondary-retriever.js'
);

/** Les 23 textes du dictionnaire par défaut : 7 termes français et 16 traductions. */
const DICTIONARY = Object.entries(ACADEMIC_TERMS_FR_TO_EN).flatMap(([fr, ens]) => [fr, ...ens]);

/** Ce que le `journal.db` du projet contient, une fois les écritures en attente faites. */
function journalEvents(): Array<{ kind: string; chunkCount?: number; status: string }> {
  usageJournalService.getToday();
  return usageJournalService.getStore()?.getEventsBetween('0000', '9999') ?? [];
}

let project = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-prechauffages-'));
  state.sent.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await pdfService.close();
  usageJournalService.close();
  fs.rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('ouvrir un projet, au journal d’usage (J11)', () => {
  it('le modèle se charge, mais rien n’est inscrit, et aucun terme du dictionnaire ne part ; une vraie question s’inscrit', async () => {
    expect(DICTIONARY).toHaveLength(23);
    // L'ouverture lance d'elle-même le préchauffage, puis, une fois fini, la reconstruction d'office.
    const rebuild = vi.spyOn(PdfVectorStore, 'maybeRebuild');

    usageJournalService.init(project);
    await pdfService.init(project);
    await vi.waitFor(() => expect(rebuild).toHaveBeenCalled(), { timeout: 5_000 });

    // Le modèle d'embeddings a bien été chargé à l'ouverture…
    expect(state.sent).toContain('warmup query');
    // … sans qu'aucun terme du dictionnaire ne parte, ni que l'ouverture ne s'inscrive.
    expect(state.sent.filter((text) => DICTIONARY.includes(text))).toEqual([]);
    expect(journalEvents().filter((e) => e.kind === 'embedding')).toEqual([]);

    await retrievalService.search({ query: 'Les grèves des dockers de Nantes en 1955', sourceType: 'secondary' });

    expect(journalEvents().map((e) => [e.kind, e.chunkCount, e.status])).toEqual([['embedding', 1, 'ok']]);
  });
});
