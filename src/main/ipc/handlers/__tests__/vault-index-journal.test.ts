/**
 * `fusion:vault:index` inscrit son lot d'embeddings au journal d'usage du projet qui a lancé
 * l'indexation, ou nulle part (S10-1-33, L03-6).
 *
 * Le lot (`runBatch('obsidian')`) ne portait aucune racine de projet : une indexation du vault
 * Obsidian lancée dans A et finie après l'ouverture de B entrait dans le `journal.db` de B, sous la
 * racine de B. Ce journal se copie et se publie seul (ADR 0007).
 *
 * Vrais handler, lecteur et magasin du vault (un vrai dossier, un vrai brain.db), service du
 * journal d'usage, `runBatch` et décorateur des fournisseurs ; sont simulés le projet courant du
 * main, le fournisseur d'embeddings (retenu tant qu'on ne le relâche pas) et le magasin du journal
 * d'usage (un faux qui garde les événements reçus).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EmbeddingProvider, ProviderStatus } from '../../../../../backend/core/llm/providers/base.js';
import type { InferenceEvent } from '../../../../../backend/core/usage-journal/types.js';
import { sqliteAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  stores: new Map<string, { events: InferenceEvent[] }>(),
  embedding: null as EmbeddingProvider | null,
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() } };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => os.tmpdir() },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:9' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getEmbedding: () => h.embedding,
    dispose: async () => undefined,
  }),
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined },
}));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));
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

import { setupFusionHandlers } from '../fusion-handlers.js';
import { usageJournalService } from '../../../services/usage-journal-service.js';
import { instrumentEmbedding } from '../../../../../backend/core/llm/providers/instrument.js';

setupFusionHandlers();

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
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    },
    'ollama',
    'http://127.0.0.1:11434'
  );
  return { running, release };
}

const usageEvents = (project: string): InferenceEvent[] =>
  h.stores.get(path.join(project, '.cliodeck', 'journal.db'))?.events ?? [];

type Response = { success: boolean; indexed?: number; error?: string };
const event = { sender: { isDestroyed: () => false, send: vi.fn() } };
const indexVault = (): Promise<Response> =>
  h.handlers.get('fusion:vault:index')?.(event, {}) as Promise<Response>;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-vault-journal-'));
let A = '';
let B = '';

beforeEach(() => {
  A = fs.mkdtempSync(path.join(root, 'A-'));
  B = fs.mkdtempSync(path.join(root, 'B-'));
  const vault = fs.mkdtempSync(path.join(root, 'vault-'));
  fs.writeFileSync(
    path.join(vault, 'note.md'),
    `# Grève des dockers\n\n${'Les dockers ont tenu leur assemblée salle Colbert. '.repeat(20)}`
  );
  fs.mkdirSync(path.join(A, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(A, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name: 'A', vault: { path: vault } })
  );
  h.stores.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  h.projectPath = A;
  usageJournalService.init(A);
});

afterEach(() => {
  usageJournalService.close();
  h.projectPath = '';
  h.embedding = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('fusion:vault:index — le journal d’usage du projet de l’indexation (S10-1-33)', () => {
  it('finie après l’ouverture de B : le journal d’usage de B ne reçoit pas son lot d’embeddings', async () => {
    const { running, release } = holdEmbedding();
    const pending = indexVault();
    await running;

    // `project:load` : le journal de A se ferme, celui de B s'ouvre.
    usageJournalService.close();
    h.projectPath = B;
    usageJournalService.init(B);
    release();
    const result = await pending;
    usageJournalService.close();

    expect(result).toMatchObject({ success: true, indexed: 1 });
    expect(usageEvents(B)).toEqual([]);
    expect(usageEvents(A)).toEqual([]);
  });

  it('témoin : finie dans A, l’indexation entre dans le journal d’usage de A, une seule fois', async () => {
    const { release } = holdEmbedding();
    release();
    const result = await indexVault();
    usageJournalService.close();

    expect(result).toMatchObject({ success: true, indexed: 1 });
    expect(usageEvents(A)).toHaveLength(1);
    expect(usageEvents(A)[0]).toMatchObject({ kind: 'embedding_batch', corpus: 'obsidian', workspace: A });
  });
});
