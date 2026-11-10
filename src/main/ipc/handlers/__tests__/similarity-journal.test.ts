/**
 * Journal d'usage IA : une analyse de similarité reste dans son projet, jusqu'à son dernier appel
 * au modèle (S10-1-33, L03-6, revue).
 *
 * L'analyse parcourt le texte segment après segment : pour chacun, une recherche (un embedding de
 * la requête) puis un reclassement par le LLM. Elle ne s'arrête pas à l'ouverture d'un autre
 * projet. Sans racine posée par le handler, chaque appel prenait celle du journal ouvert à son
 * début : ceux lancés après l'ouverture de B entraient dans le `journal.db` de B, qui se publie
 * seul (ADR 0007).
 *
 * Vrai handler, vrai `similarityService.analyzeDocument`, vrais `instrumentLLM`,
 * `instrumentEmbedding`, `context.ts` et service du journal. Simulés : Electron, la configuration,
 * le projet courant, `pdfService` (sa recherche passe par un fournisseur d'embeddings instrumenté,
 * comme la vraie) et le magasin du journal d'usage, qui garde les événements reçus par base.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ChatChunk,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../../../../../backend/core/llm/providers/base.js';
import type { InferenceEvent } from '../../../../../backend/core/usage-journal/types.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  llm: null as unknown,
  embedding: null as unknown,
  stores: new Map<string, { events: unknown[] }>(),
}));

vi.mock('electron', () => {
  const win = { webContents: { send: () => undefined } };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    BrowserWindow: {
      fromWebContents: () => win,
      getFocusedWindow: () => win,
      getAllWindows: () => [win],
    },
    app: { isPackaged: false, getPath: () => os.tmpdir() },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:11434' }),
  },
}));

vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));

vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => h.llm,
    dispose: async () => undefined,
  }),
}));

/** Deux sources au-dessus du seuil par recherche : le reclassement par le LLM a lieu. */
vi.mock('../../../services/pdf-service.js', () => ({
  pdfService: {
    getStatistics: async () => ({ documents: 2, chunks: 2 }),
    search: async (query: string) => {
      await (h.embedding as EmbeddingProvider).embed([query]);
      return ['d1', 'd2'].map((id) => ({
        sourceType: 'secondary',
        similarity: 0.9,
        document: { id, title: `Source ${id}`, author: 'Bloch', bibtexKey: id },
        chunk: { content: `Un extrait de ${id}.` },
      }));
    },
  },
}));

vi.mock('../../../../../backend/core/usage-journal/UsageJournalStore.js', () => ({
  UsageJournalStore: class {
    readonly events: unknown[] = [];
    constructor(dbPath: string) {
      h.stores.set(dbPath, this);
    }
    insertEvents(events: unknown[]): void {
      this.events.push(...events);
    }
    close(): void {}
  },
}));

import { usageJournalService } from '../../../services/usage-journal-service.js';
import { setupSimilarityHandlers } from '../similarity-handlers.js';
import {
  instrumentEmbedding,
  instrumentLLM,
} from '../../../../../backend/core/llm/providers/instrument.js';

const READY: ProviderStatus = { state: 'ready' };

const eventsOf = (project: string): InferenceEvent[] =>
  (h.stores.get(path.join(project, '.cliodeck', 'journal.db'))?.events ?? []) as InferenceEvent[];

/** Un modèle local qui classe toujours « 1, 2 ». */
function fakeLLM(): LLMProvider {
  return instrumentLLM(
    {
      id: 'fake',
      name: 'Fake',
      model: 'fake-model',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => READY,
      healthCheck: async () => READY,
      dispose: async () => undefined,
      async *chat(): AsyncIterable<ChatChunk> {
        yield { delta: '1, 2', done: true, finishReason: 'stop' };
      },
      complete: async () => '1, 2',
    },
    'ollama',
    'http://127.0.0.1:11434'
  );
}

/** Un fournisseur d'embeddings local dont le premier appel attend `release()`. */
function heldEmbedding(): { embedding: EmbeddingProvider; entered: Promise<void>; release: () => void } {
  let enter = (): void => undefined;
  let release = (): void => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = true;
  const inner: EmbeddingProvider = {
    id: 'fake-emb',
    name: 'Fake Emb',
    dimension: 3,
    model: 'fake-embed',
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    embed: async (texts: string[]) => {
      if (held) {
        held = false;
        enter();
        await released;
      }
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
  return { embedding: instrumentEmbedding(inner, 'ollama', 'http://127.0.0.1:11434'), entered, release };
}

const event = { sender: { isDestroyed: () => false, send: () => undefined } };

function analyze(text: string): Promise<{ success: boolean; error?: string }> {
  const fn = h.handlers.get('similarity:analyze');
  if (!fn) throw new Error('handler absent : similarity:analyze');
  return fn(event, text, { granularity: 'paragraph', useContextualEmbedding: false }) as Promise<{
    success: boolean;
    error?: string;
  }>;
}

/** Deux paragraphes : deux recherches et deux reclassements. */
const TEXT =
  'Le port de Danzig est disputé depuis 1919, entre la Pologne et la ville libre.\n\n' +
  'Les élections de 1932 marquent une rupture dans la vie politique de la ville.\n';

setupSimilarityHandlers();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-similarity-journal-'));
let A = '';
let B = '';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  A = fs.mkdtempSync(path.join(tmp, 'A-'));
  B = fs.mkdtempSync(path.join(tmp, 'B-'));
  h.stores.clear();
  h.llm = fakeLLM();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  usageJournalService.close();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('similarity:analyze — journal d’usage du projet de l’analyse (S10-1-33)', () => {
  it('les appels lancés après l’ouverture de B n’entrent pas dans le journal de B', async () => {
    const { embedding, entered, release } = heldEmbedding();
    h.embedding = embedding;
    h.projectPath = A;
    usageJournalService.init(A);
    const pending = analyze(TEXT);
    await entered;

    // Ouverture de B pendant la recherche du premier segment.
    h.projectPath = B;
    usageJournalService.close();
    usageJournalService.init(B);
    release();
    const res = await pending;
    usageJournalService.close();

    expect(res.success).toBe(true);
    expect(eventsOf(B)).toEqual([]);
    expect(warn.mock.calls.flat().map(String).join('\n')).toContain(A);
  });

  it('témoin : sans bascule, les recherches et les reclassements entrent dans le journal de A', async () => {
    const { embedding, release } = heldEmbedding();
    release();
    h.embedding = embedding;
    h.projectPath = A;
    usageJournalService.init(A);
    const res = await analyze(TEXT);
    usageJournalService.close();

    expect(res.success).toBe(true);
    expect(eventsOf(A).map((e) => [e.kind, e.workspace])).toEqual([
      ['embedding', A],
      ['completion', A],
      ['embedding', A],
      ['completion', A],
    ]);
  });
});
