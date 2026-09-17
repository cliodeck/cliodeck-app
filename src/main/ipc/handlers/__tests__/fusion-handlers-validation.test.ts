/**
 * Validation des entrées de `fusion-handlers` (dette n° 18).
 *
 * La plupart des handlers contrôlaient déjà leurs entrées à la main ; ces
 * tests couvrent les cinq qui ne le faisaient pas, ou mal : chemin du coffre
 * accepté sans dialogue, `maxFiles` non contrôlé, accord de consentement
 * enregistré sous le libellé du renderer, `inputs` de recette converti de
 * force, `recentLimit` sans borne.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  llmConfig: { backend: 'claude', ollamaURL: 'http://127.0.0.1:11434' } as Record<string, unknown>,
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
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    BrowserWindow: {
      fromWebContents: () => win,
      getFocusedWindow: () => win,
      getAllWindows: () => [win],
    },
    app: { isPackaged: false, getPath: () => '/tmp' },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => h.llmConfig },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({ retrievalService: {} }));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined },
}));

import { cloudConsent } from '../../../../../backend/security/cloud-consent.js';
import {
  __resetConsentedPaths,
  rememberConsentedPath,
} from '../../utils/user-consented-paths.js';
import { setupFusionHandlers } from '../fusion-handlers.js';

type Response = { success: boolean; error?: string } & Record<string, unknown>;

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };

function invoke(channel: string, ...args: unknown[]): Promise<Response> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`handler absent : ${channel}`);
  return fn(event, ...args) as Promise<Response>;
}

setupFusionHandlers();

let project = '';
let outside = '';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-fusion-projet-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-fusion-coffre-'));
  h.projectPath = project;
  h.llmConfig = { backend: 'claude', ollamaURL: 'http://127.0.0.1:11434' };
  cloudConsent.revoke();
  __resetConsentedPaths();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function workspaceConfig(): Record<string, unknown> {
  const p = path.join(project, '.cliodeck', 'config.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
}

describe('fusion:vault:set-path — seulement un dossier choisi dans le dialogue', () => {
  it('refuse un dossier que l’utilisateur n’a pas choisi, sans rien écrire', async () => {
    const res = await invoke('fusion:vault:set-path', outside);

    expect(res.success).toBe(false);
    expect(res.error).toContain('dialog');
    expect(workspaceConfig().vault).toBeUndefined();
  });

  it('accepte le dossier retourné par le dialogue natif', async () => {
    await rememberConsentedPath(outside);
    const res = await invoke('fusion:vault:set-path', outside);

    expect(res.success).toBe(true);
    expect((workspaceConfig().vault as { path: string }).path).toBe(outside);
  });
});

describe('fusion:vault:import-as-ideas — options contrôlées', () => {
  beforeEach(async () => {
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(outside, `${n}.md`), `# Note ${n}\n\nTexte.\n`);
    await rememberConsentedPath(outside);
    await invoke('fusion:vault:set-path', outside);
  });

  it('refuse un maxFiles qui n’est pas un entier, au lieu d’importer sans borne', async () => {
    const res = await invoke('fusion:vault:import-as-ideas', { maxFiles: 'tout' });
    expect(res.success).toBe(false);
    expect(res.count).toBeUndefined();
  });

  it('applique la borne demandée', async () => {
    const res = await invoke('fusion:vault:import-as-ideas', { maxFiles: 2 });
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);
  });
});

describe('fusion:consent:grant — l’accord porte sur le fournisseur que le main appellera', () => {
  it('n’accorde rien pour un autre fournisseur que celui de la configuration', async () => {
    const res = await invoke('fusion:consent:grant', 'Mistral AI');

    expect(res).toMatchObject({ success: true, granted: false, reason: 'provider_mismatch' });
    expect(cloudConsent.isGranted()).toBe(false);
  });

  it('n’accorde rien sans fournisseur nommé', async () => {
    const res = await invoke('fusion:consent:grant');
    expect(res.granted).toBe(false);
    expect(cloudConsent.isGranted()).toBe(false);
  });

  it('accorde pour le fournisseur configuré, sous le nom du main', async () => {
    const res = await invoke('fusion:consent:grant', 'Anthropic Claude');

    expect(res).toMatchObject({ granted: true, consentedProvider: 'Anthropic Claude' });
    expect(cloudConsent.consentedProvider()).toBe('Anthropic Claude');
  });
});

describe('fusion:recipes:run — inputs contrôlés', () => {
  beforeEach(() => {
    // Fournisseur local : le registre se construit sans clé d'API.
    h.llmConfig = { backend: 'ollama', ollamaURL: 'http://127.0.0.1:11434' };
    const dir = path.join(project, '.cliodeck', 'recipes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'export.yaml'),
      'name: essai\nversion: 0.1.0\ndescription: essai\nsteps:\n  - id: etape\n    kind: export\n    with:\n      format: pdf\n'
    );
  });

  it('refuse des inputs qui ne sont pas un objet', async () => {
    for (const bad of ['texte', ['a', 'b'], 42]) {
      const res = await invoke('fusion:recipes:run', 'user', 'export.yaml', bad);
      expect(res.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepte un objet, ou l’absence d’inputs', async () => {
    expect((await invoke('fusion:recipes:run', 'user', 'export.yaml', {})).success).toBe(true);
    expect((await invoke('fusion:recipes:run', 'user', 'export.yaml')).success).toBe(true);
  });
});

describe('fusion:security:get-events — recentLimit borné', () => {
  it('refuse une limite démesurée ou non entière', async () => {
    expect((await invoke('fusion:security:get-events', { recentLimit: 1e9 })).success).toBe(false);
    expect((await invoke('fusion:security:get-events', { recentLimit: 'dix' })).success).toBe(false);
  });

  it('accepte une limite raisonnable, ou aucune', async () => {
    expect((await invoke('fusion:security:get-events', { recentLimit: 20 })).success).toBe(true);
    expect((await invoke('fusion:security:get-events')).success).toBe(true);
  });
});
