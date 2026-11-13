/**
 * `fusion:vault:index` : la fermeture du projet coupe la requête d'embedding de l'indexation (J9).
 *
 * L'indexation du coffre Obsidian était le seul appelant d'`embed` lié à un projet qui ne passait
 * aucun signal. Le handler construit son propre registre (Ollama sans délai d'en-têtes) et son
 * propre magasin sur le brain.db du projet : Ollama figé, la fermeture du projet ne touchait à rien,
 * et la requête restait ouverte jusqu'au redémarrage de l'app, le brain.db du projet quitté avec.
 *
 * Vrais handler, lecteur, indexeur et magasin du vault (un vrai dossier, un vrai brain.db), vrai
 * registre des opérations. La fermeture est celle du service `operations` de `project-services` :
 * `cancelScope('project', 'project-closed')`, puis `drain('project', …)`. Simulés : le projet
 * courant du main et le fournisseur d'embeddings, qui se comporte comme `fetch` : une demande
 * retenue ne répond pas, et rejette par la raison de son signal quand il s'avorte. Sans signal,
 * rien ne l'arrête : c'est le défaut.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { EmbeddingProvider, ProviderStatus } from '../../../../../backend/core/llm/providers/base.js';
import { sqliteAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

interface HeldRequest {
  texts: string[];
  signal: AbortSignal | undefined;
  /** Rend la réponse : seulement pour libérer, à la fin d'un test, une demande que rien n'a coupée. */
  release: () => void;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  held: [] as HeldRequest[],
  /** Vrai en fin de test : toute demande répond aussitôt, pour qu'une passe que rien n'a coupée finisse. */
  answerAll: false,
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

import { setupFusionHandlers } from '../fusion-handlers.js';
import { operations } from '../../../services/cancellable-operation.js';
import { ObsidianVaultStore } from '../../../../../backend/integrations/obsidian/ObsidianVaultStore.js';

setupFusionHandlers();

const READY: ProviderStatus = { state: 'ready' };

/** Un Ollama figé : chaque demande attend, jusqu'à ce que son signal s'avorte. */
function frozenEmbedding(): EmbeddingProvider {
  return {
    id: 'fake-emb',
    name: 'Fake Emb',
    dimension: 3,
    model: 'fake-embed',
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    embed: (texts: string[], opts?: { signal?: AbortSignal }) => {
      const signal = opts?.signal;
      if (h.answerAll) return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]));
      return new Promise<number[][]>((resolve, reject) => {
        h.held.push({ texts, signal, release: () => resolve(texts.map(() => [0.1, 0.2, 0.3])) });
        if (!signal) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
}

type Response = { success: boolean; indexed?: number; error?: string };
const event = { sender: { isDestroyed: () => false, send: vi.fn() } };
const indexVault = (): Promise<Response> =>
  h.handlers.get('fusion:vault:index')?.(event, {}) as Promise<Response>;

/** Ce que le brain.db du projet garde du coffre, lu par une autre connexion. */
function vaultRows(project: string): { notes: number; chunks: number } {
  const db = new Database(path.join(project, '.cliodeck', 'brain.db'), { readonly: true });
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { notes: count('obsidian_notes'), chunks: count('obsidian_chunks') };
  } finally {
    db.close();
  }
}

/** Une attente de résultat, pas un délai : la borne n'est qu'un garde-fou pour une CI lente. */
const WAIT = { timeout: 10_000 };
/** Un signal coupé l'est tout de suite ; au-delà, c'est qu'aucun signal n'est arrivé jusqu'à `embed`. */
const ABORT_WAIT = { timeout: 2_000 };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-vault-abandon-'));
let A = '';
let pending: Promise<Response> | null = null;

beforeEach(() => {
  A = fs.mkdtempSync(path.join(root, 'A-'));
  const vault = fs.mkdtempSync(path.join(root, 'vault-'));
  fs.writeFileSync(
    path.join(vault, 'greve.md'),
    `# Grève des dockers\n\n${'Les dockers ont tenu leur assemblée salle Colbert. '.repeat(20)}`
  );
  fs.writeFileSync(path.join(vault, 'comite.md'), '# Comité de grève\n\nLe comité a porté les revendications.');
  fs.mkdirSync(path.join(A, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(A, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name: 'A', vault: { path: vault } })
  );
  h.held.length = 0;
  h.answerAll = false;
  h.embedding = frozenEmbedding();
  h.projectPath = A;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  // Une demande que rien n'a coupée (le défaut) se libère ici : la passe finit, et ne déborde pas
  // sur le test suivant.
  h.answerAll = true;
  for (const request of h.held) request.release();
  await pending;
  pending = null;
  h.projectPath = '';
  h.embedding = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('fusion:vault:index — fermeture du projet pendant un embedding (J9)', () => {
  it('la requête est coupée, la passe s’arrête sans rien écrire, et la fermeture n’attend pas', async () => {
    const close = vi.spyOn(ObsidianVaultStore.prototype, 'close');
    pending = indexVault();
    await vi.waitFor(() => expect(h.held).toHaveLength(1), WAIT);

    // La fermeture du projet : le service `operations` de `project-services`.
    operations.cancelScope('project', 'project-closed');

    await vi.waitFor(() => expect(h.held[0].signal?.aborted).toBe(true), ABORT_WAIT);
    expect(await pending).toEqual({ success: false, error: 'project-changed' });
    expect(await operations.drain('project', 5_000)).toBe(true);
    expect(operations.active('vault-index')).toEqual([]);
    // Le magasin du handler, ouvert sur le brain.db du projet quitté, est fermé.
    expect(close).toHaveBeenCalled();
    // Une seule demande : la note suivante ne part pas chez le fournisseur.
    expect(h.held).toHaveLength(1);
    expect(vaultRows(A)).toEqual({ notes: 0, chunks: 0 });
  });

  it('témoin : sans fermeture, l’indexation finit et s’efface du registre des opérations', async () => {
    pending = indexVault();
    await vi.waitFor(() => expect(h.held).toHaveLength(1), WAIT);
    expect(operations.active('vault-index')).toHaveLength(1);
    expect(h.held[0].signal?.aborted).toBe(false);

    h.held[0].release();
    await vi.waitFor(() => expect(h.held).toHaveLength(2), WAIT);
    h.held[1].release();

    expect(await pending).toMatchObject({ success: true, indexed: 2, failed: 0 });
    expect(operations.active('vault-index')).toEqual([]);
    expect(vaultRows(A).notes).toBe(2);
  });
});
