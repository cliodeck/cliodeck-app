/**
 * L'accord donné à l'ajout d'un serveur MCP (S09-2-6). `fusion:mcp:add` pose la question, puis
 * écrit le serveur dans config.json, mais ne retenait rien : au chargement suivant du projet, le
 * garde des serveurs déclarés reposait la même question pour un serveur que l'historien venait
 * d'ajouter, et un « Annuler », logique quand on croit l'avoir déjà ajouté, le laissait éteint.
 *
 * Les vrais handlers, le vrai service des clients MCP et le vrai garde, sur un projet temporaire.
 * Electron est simulé : `app.getPath('userData')` rend un dossier temporaire, jamais le userData de
 * l'auteur, et seul le dialogue natif répond à la place de l'historien. Le coffre des clés est une
 * table en mémoire. Commandes absentes et adresse sur un port fermé : un démarrage échoue vite,
 * sans réseau.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
  projectPath: '',
  showMessageBox: vi.fn(),
  secrets: new Map<string, string>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: { showMessageBox: h.showMessageBox },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
  app: { isPackaged: false, getPath: () => h.userData },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock('../../../services/secure-storage.js', () => ({
  secureStorage: {
    setKey: (k: string, v: string) => void h.secrets.set(k, v),
    getKey: (k: string) => h.secrets.get(k) ?? '',
    deleteKey: (k: string) => void h.secrets.delete(k),
    hasKey: (k: string) => h.secrets.has(k),
  },
  SENSITIVE_KEYS: [],
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
// Dépendances lourdes de fusion-handlers, sans rapport avec les serveurs MCP.
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: {} }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

import type { MCPClientConfig } from '../../../../../backend/core/workspace/config.js';
import { fingerprintClient } from '../../../services/mcp-approval-registry.js';
import { SECRET_SENTINEL } from '../../../services/mcp-env-secrets.js';

type Service = (typeof import('../../../services/mcp-clients-service.js'))['mcpClientsService'];
type Gate = typeof import('../../../services/mcp-approval-gate.js');

const EUROPEANA = {
  name: 'europeana',
  transport: 'stdio' as const,
  command: '/nonexistent/cliodeck-europeana',
  args: ['--lang', 'fr'],
};

let service: Service;
let gate: Gate;
const roots: string[] = [];

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mcp-accord-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name: 'Thèse', mcpClients: [] }, null, 2)
  );
  return root;
}

const diskClients = (root: string): MCPClientConfig[] =>
  JSON.parse(fs.readFileSync(path.join(root, '.cliodeck', 'config.json'), 'utf8')).mcpClients ?? [];

/** Les empreintes retenues sur le disque, dans le userData temporaire. */
function approvedOnDisk(): string[] {
  const file = path.join(h.userData, 'mcp-approvals.json');
  return fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))) : [];
}

/** Le dialogue natif répond : 1 = « Ajouter », 0 = « Annuler ». */
function answer(response: 0 | 1): void {
  h.showMessageBox.mockResolvedValue({ response, checkboxChecked: false });
}

function add(client: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const handler = h.handlers.get('fusion:mcp:add');
  if (!handler) throw new Error('canal non enregistré : fusion:mcp:add');
  return handler({ sender: {} }, client) as Promise<{ success: boolean; error?: string }>;
}

beforeEach(async () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-userdata-'));
  h.projectPath = makeProject();
  h.showMessageBox.mockReset();
  h.secrets.clear();
  // Un registre des accords neuf par test : le module le garde en singleton, sur le premier userData lu.
  vi.resetModules();
  const handlers = await import('../fusion-handlers.js');
  ({ mcpClientsService: service } = await import('../../../services/mcp-clients-service.js'));
  gate = await import('../../../services/mcp-approval-gate.js');
  handlers.setupFusionHandlers();
  // Comme à la création d'un projet : aucun serveur déclaré, donc aucune question.
  await service.loadProject(h.projectPath);
});

afterEach(async () => {
  await service.unload();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(h.userData, { recursive: true, force: true });
});

describe('fusion:mcp:add retient l’accord donné (S09-2-6)', () => {
  it('serveur avec une clé d’API : le chargement suivant du projet ne repose pas la question', async () => {
    answer(1);
    const res = await add({ ...EUROPEANA, env: { EUROPEANA_API_KEY: 'cle-test', EUROPEANA_LANG: 'fr' } });
    expect(res.success).toBe(true);
    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    // Sur le disque, la sentinelle : c'est elle qu'entre l'empreinte vue au chargement.
    const [written] = diskClients(h.projectPath);
    expect(written.env).toEqual({ EUROPEANA_API_KEY: SECRET_SENTINEL, EUROPEANA_LANG: 'fr' });

    // Si la question revenait, l'historien, qui croit l'avoir déjà ajouté, répondrait « Annuler ».
    answer(0);
    await service.loadProject(h.projectPath);

    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
    expect(service.list().map((c) => c.name)).toEqual(['europeana']);
    // Retenu sur le disque, pour les lancements suivants : la sentinelle, jamais la clé en clair.
    expect(approvedOnDisk()).toEqual([fingerprintClient(written)]);
    expect(approvedOnDisk()).not.toContain(
      fingerprintClient({ ...EUROPEANA, env: { EUROPEANA_API_KEY: 'cle-test', EUROPEANA_LANG: 'fr' } })
    );
  });

  it('serveur SSE : le garde le laisse passer sans question au chargement suivant', async () => {
    const sse = { name: 'archives', transport: 'sse' as const, url: 'http://127.0.0.1:9/sse' };
    answer(1);
    expect((await add(sse)).success).toBe(true);

    answer(0);
    expect(await gate.defaultMcpApprovalGate(diskClients(h.projectPath)[0], h.projectPath)).toBe('approved');
    expect(h.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('ajout refusé : aucun accord retenu, le chargement repose la question', async () => {
    answer(0);
    const res = await add(EUROPEANA);
    expect(res.error).toBe('mcp_add_rejected:user_cancelled');

    expect(approvedOnDisk()).toEqual([]);
    expect(await gate.defaultMcpApprovalGate(EUROPEANA, h.projectPath)).toBe('rejected');
    expect(h.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('ajout en échec (nom déjà déclaré) : l’accord de cette autre commande n’est pas retenu', async () => {
    answer(1);
    expect((await add(EUROPEANA)).success).toBe(true);
    const other = { ...EUROPEANA, args: ['--lang', 'de'] };

    const res = await add(other);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/);
    expect(approvedOnDisk()).toEqual([fingerprintClient(EUROPEANA)]);
  });

  it('un autre projet ouvert pendant l’écriture : l’accord vaut pour le projet de départ, où le serveur est écrit', async () => {
    const rootA = h.projectPath;
    const rootB = makeProject();
    let asked = false;
    h.showMessageBox.mockImplementation(async () => {
      asked = true;
      return { response: 1, checkboxChecked: false };
    });
    // L'écriture lit l'env (migration des secrets) : B s'ouvre là, après la question, avant la
    // fin de l'écriture du config.json de A.
    let loadingB: Promise<void> | null = null;
    const env: Record<string, string> = {};
    Object.defineProperty(env, 'EUROPEANA_LANG', {
      enumerable: true,
      get() {
        if (asked) loadingB ??= service.loadProject(rootB);
        return 'fr';
      },
    });

    const res = await add({ ...EUROPEANA, env });
    await loadingB;

    expect(loadingB).not.toBeNull();
    expect(res.success).toBe(true);
    expect(diskClients(rootA)).toEqual([{ ...EUROPEANA, env: { EUROPEANA_LANG: 'fr' } }]);
    expect(diskClients(rootB)).toEqual([]);

    // A rouvert : le serveur démarre sans seconde question.
    h.showMessageBox.mockReset();
    answer(0);
    await service.loadProject(rootA);

    expect(h.showMessageBox).not.toHaveBeenCalled();
    expect(service.list().map((c) => c.name)).toEqual(['europeana']);
  });
});
