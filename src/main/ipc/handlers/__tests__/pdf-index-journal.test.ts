/**
 * `pdf:index` inscrit l'indexation dans les journaux du projet qui l'a lancée, ou nulle part
 * (S03-1-20, L03-6).
 *
 * Le handler relisait le journal de recherche courant après la longue attente de l'indexation, et
 * le lot d'embeddings (`runBatch`) ne portait aucune racine de projet : une indexation de A finie
 * après l'ouverture de B s'inscrivait dans le journal de recherche de B (« import » d'un document
 * inconnu de B) et dans son journal d'usage, qui se publie seul (ADR 0007).
 *
 * Vrais handler, journal de recherche (SQLite), service du journal d'usage et `runBatch` ; sont
 * simulés le projet courant du main, l'indexation (un lot d'embeddings retenu, comme celui de
 * `PdfIndexer.indexPDF`) et le magasin du journal d'usage (un faux qui garde les événements reçus).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EmbeddingProvider, ProviderStatus } from '../../../../../backend/core/llm/providers/base.js';
import type { InferenceEvent } from '../../../../../backend/core/usage-journal/types.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  current: null as string | null,
  embedding: null as EmbeddingProvider | null,
  stores: new Map<string, { events: InferenceEvent[] }>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.current },
}));
// Comme `PdfIndexer.indexPDF` : l'indexation tient dans un lot d'embeddings.
vi.mock('../../../services/pdf-service.js', async () => {
  const { runBatch } = await import('../../../../../backend/core/usage-journal/context.js');
  return {
    pdfService: {
      indexPDF: (filePath: string) =>
        runBatch('pdf', async () => {
          await h.embedding?.embed(['un extrait', 'un autre']);
          return { id: `doc-${path.basename(filePath)}`, title: 'A1', pageCount: 1, metadata: {} };
        }),
    },
  };
});
vi.mock('../../../../../backend/core/usage-journal/UsageJournalStore.js', () => ({
  UsageJournalStore: class {
    readonly events: InferenceEvent[] = [];
    constructor(dbPath: string) {
      h.stores.set(dbPath, this);
    }
    insertEvents(events: InferenceEvent[]): void {
      this.events.push(...events);
    }
    close(): void {}
  },
}));

const { setupPDFHandlers } = await import('../pdf-handlers.js');
const { historyService } = await import('../../../services/history-service.js');
const { usageJournalService } = await import('../../../services/usage-journal-service.js');
const { HistoryManager } = await import('../../../../../backend/core/history/HistoryManager.js');
const { instrumentEmbedding } = await import('../../../../../backend/core/llm/providers/instrument.js');
setupPDFHandlers();

const READY: ProviderStatus = { state: 'ready' };

/** Un fournisseur d'embeddings local qui ne rend la main qu'une fois relâché. */
function holdEmbedding(): { running: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const running = new Promise<void>((resolve) => (started = resolve));
  h.embedding = instrumentEmbedding(
    {
      id: 'fake-emb',
      name: 'Fake Emb',
      dimension: 3,
      model: 'fake-embed',
      getStatus: () => READY,
      healthCheck: async () => READY,
      dispose: async () => undefined,
      embed: async (texts: string[]) => {
        started();
        await gate;
        return texts.map(() => [0, 0, 0]);
      },
    },
    'ollama',
    'http://127.0.0.1:11434'
  );
  return { running, release };
}

type Response = { success: boolean; error?: string };
const index = (project: string) =>
  h.handlers.get('pdf:index')?.({ sender: {} }, path.join(project, 'PDFs', 'a1.pdf'), 'a1', { title: 'A1' }, project) as Promise<Response>;

/** Les opérations PDF du journal de recherche d'un projet, lues par une connexion à part. */
function pdfOperations(project: string): string[] {
  const reader = new HistoryManager(project);
  try {
    return reader.getAllPDFOperations().map((op) => `${op.operationType} ${op.documentId}`);
  } finally {
    reader.close();
  }
}

const usageEvents = (project: string): InferenceEvent[] =>
  h.stores.get(path.join(project, '.cliodeck', 'journal.db'))?.events ?? [];

/** Les journaux du projet ouvert, comme les ouvre la séquence (`project-services.ts`). */
async function openJournals(project: string): Promise<void> {
  h.current = project;
  await historyService.init(project);
  usageJournalService.init(project);
}

function closeJournals(): void {
  historyService.close();
  usageJournalService.close();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-index-journal-'));
let A = '';
let B = '';

beforeEach(async () => {
  A = fs.mkdtempSync(path.join(root, 'A-'));
  B = fs.mkdtempSync(path.join(root, 'B-'));
  h.stores.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await openJournals(A);
});

afterEach(() => {
  closeJournals();
  h.current = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pdf:index — les journaux du projet de l’indexation (S03-1-20)', () => {
  /** Une indexation de A, finie après la fermeture des journaux de A et l'ouverture de ceux de B. */
  async function indexAcrossSwitch(): Promise<Response> {
    const { running, release } = holdEmbedding();
    const pending = index(A);
    await running;

    closeJournals();
    await openJournals(B);
    release();
    const result = await pending;
    usageJournalService.close();
    return result;
  }

  it('finie après l’ouverture de B : le journal de recherche de B ne la reçoit pas', async () => {
    const result = await indexAcrossSwitch();

    expect(result.success).toBe(true);
    expect(pdfOperations(B)).toEqual([]);
  });

  it('finie après l’ouverture de B : le journal d’usage de B ne reçoit pas son lot d’embeddings', async () => {
    const result = await indexAcrossSwitch();

    expect(result.success).toBe(true);
    expect(usageEvents(B)).toEqual([]);
  });

  it('témoin : finie dans A, l’indexation s’inscrit dans les deux journaux de A', async () => {
    const { release } = holdEmbedding();
    release();
    const result = await index(A);
    closeJournals();

    expect(result.success).toBe(true);
    expect(pdfOperations(A)).toEqual(['import doc-a1.pdf']);
    expect(usageEvents(A)).toHaveLength(1);
    expect(usageEvents(A)[0]).toMatchObject({ kind: 'embedding_batch', workspace: A, chunkCount: 2 });
  });
});
