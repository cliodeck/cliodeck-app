/**
 * `.cliodeck` lié hors du projet, vu des handlers `fusion:*` qui écrivent ou lisent ses fichiers sans
 * passer par `config.json` : recettes, journal des recettes, journal de sécurité (D18). Ils suivaient
 * le lien, écritures comprises.
 *
 * Les vrais handlers sur un vrai dossier ; seuls les services voisins sont simulés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { symlinkAvailable } from '../../../../../backend/__tests__/helpers/native-guards.js';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => h.projectPath },
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
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: { setInspectorMode: vi.fn(), getInspectorMode: () => 'warn' },
}));
vi.mock('../../../services/secure-storage.js', () => ({
  secureStorage: { revokeAll: () => 0 },
  SENSITIVE_KEYS: [],
}));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined, list: () => [] },
}));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: {} }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));

import { setupFusionHandlers } from '../fusion-handlers.js';

const RECIPE =
  'name: autre\nversion: 0.1.0\ndescription: recette d’un autre projet\nsteps:\n  - id: a\n    kind: search\n    with:\n      source: zotero\n';

let workDir: string;
let root: string;
let outside: string;

function call<T = { success: boolean; error?: string } & Record<string, unknown>>(
  channel: string,
  ...args: unknown[]
): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, ...args) as Promise<T>;
}

/** Tout le dossier : chaque entrée, sa taille, sa date, ses octets. */
function folderState(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.join(prefix, name);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      out[`${rel}/`] = String(stat.mtimeMs);
      Object.assign(out, folderState(full, rel));
    } else {
      out[rel] = `${stat.size}|${stat.mtimeMs}|${fs.readFileSync(full).toString('base64')}`;
    }
  }
  out['.'] = String(fs.statSync(dir).mtimeMs);
  return out;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-fusion-lie-'));
  root = path.join(workDir, 'Thèse');
  outside = path.join(workDir, 'ailleurs');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(outside, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'recipes', 'autre.yaml'), RECIPE);
  fs.writeFileSync(path.join(outside, 'security-events.jsonl'), '{"kind":"autre"}\n');
  h.projectPath = root;
  h.handlers.clear();
  setupFusionHandlers();
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!symlinkAvailable)('fusion:* — .cliodeck lié hors du projet', () => {
  beforeEach(() => {
    fs.symlinkSync(outside, path.join(root, '.cliodeck'));
  });

  it('recipes:save : refusé, rien d’écrit à l’autre bout', async () => {
    const before = folderState(outside);

    const result = await call('fusion:recipes:save', 'nouvelle.yaml', RECIPE);

    expect(result.success).toBe(false);
    expect(result.error).toContain('hors du projet');
    expect(folderState(outside)).toEqual(before);
  });

  it('recipes:list, read et read-yaml : les recettes de l’autre bout ne sont pas lues', async () => {
    const list = await call<{ success: boolean; user?: unknown[]; builtin?: unknown[] }>('fusion:recipes:list');
    const read = await call('fusion:recipes:read', 'user', 'autre.yaml');
    const yaml = await call('fusion:recipes:read-yaml', 'user', 'autre.yaml');

    expect(list.success).toBe(true);
    expect(list.user).toEqual([]);
    expect(list.builtin?.length).toBeGreaterThan(0);
    expect(read.success).toBe(false);
    expect(yaml.success).toBe(false);
    expect(yaml).not.toHaveProperty('yaml');
  });

  it('recipes:run : refusé avant tout journal de passe', async () => {
    const before = folderState(outside);

    const result = await call('fusion:recipes:run', 'builtin', 'export-chapitre-chicago.yaml', {});

    expect(result.success).toBe(false);
    expect(folderState(outside)).toEqual(before);
  });

  it('security:get-events ne lit pas, revoke-all-keys n’y ajoute rien', async () => {
    const before = folderState(outside);

    const events = await call('fusion:security:get-events');
    await call('fusion:security:revoke-all-keys');

    expect(events.success).toBe(false);
    expect(folderState(outside)).toEqual(before);
  });
});

describe('témoin : un vrai dossier .cliodeck', () => {
  it('recipes:save écrit, comme avant', async () => {
    const result = await call('fusion:recipes:save', 'nouvelle.yaml', RECIPE);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, '.cliodeck', 'recipes', 'nouvelle.yaml'), 'utf8')).toBe(RECIPE);
  });
});
