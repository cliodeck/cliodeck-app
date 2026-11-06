/**
 * S09-1-13, vu du handler `fusion:vault:index` : un coffre lié qui contient le projet indexait
 * `reading-notes/*.md` et `document.md` comme notes Obsidian, hors du consentement des notes de
 * lecture et de la politique du manuscrit.
 *
 * Le vrai handler, le vrai lecteur, un vrai dossier ; l'indexeur est réduit à ce qu'il reçoit du
 * scan, le store et les fournisseurs sont simulés (aucun appel réseau).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  scanned: [] as string[],
}));

vi.mock('electron', () => {
  const win = { webContents: { send: vi.fn() }, isDestroyed: () => false };
  return {
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
        h.handlers.set(channel, fn);
      },
    },
    dialog: {},
    BrowserWindow: { fromWebContents: () => win, getFocusedWindow: () => win, getAllWindows: () => [win] },
    app: { isPackaged: false, getPath: () => h.projectPath },
    shell: {},
    safeStorage: { isEncryptionAvailable: () => false },
  };
});

vi.mock('../../../services/config-manager.js', () => ({
  configManager: { getLLMConfig: () => ({ backend: 'ollama' }) },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/fusion-chat-service.js', () => ({ fusionChatService: {} }));
vi.mock('../../../services/retrieval-service.js', () => ({
  retrievalService: { setInspectorMode: vi.fn(), getInspectorMode: () => 'warn' },
}));
vi.mock('../../../services/secure-storage.js', () => ({ secureStorage: {}, SENSITIVE_KEYS: [] }));
vi.mock('../../../services/recipe-step-handlers.js', () => ({ recipeStepHandlers: {} }));
vi.mock('../../../services/mcp-clients-service.js', () => ({
  mcpClientsService: { subscribe: () => () => undefined, list: () => [] },
}));
vi.mock('../../../services/tropy-service.js', () => ({ tropyService: {} }));
vi.mock('../../../services/pdf-service.js', () => ({ pdfService: {} }));
vi.mock('../../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getEmbedding: () => ({ dimension: 4 }),
    dispose: async () => undefined,
  }),
}));
vi.mock('../../../../../backend/integrations/obsidian/ObsidianVaultStore.js', () => ({
  ObsidianVaultStore: class {
    static purgeObsidianData = vi.fn();
    close(): void {}
  },
}));
vi.mock('../../../../../backend/integrations/obsidian/ObsidianVaultIndexer.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    ObsidianVaultIndexer: class {
      private reader: { getAllEntries(): Array<{ relativePath: string }> };
      constructor(reader: { getAllEntries(): Array<{ relativePath: string }> }) {
        this.reader = reader;
      }
      async indexAll() {
        h.scanned = this.reader.getAllEntries().map((e) => e.relativePath).sort();
        return { indexed: h.scanned, skipped: [], failed: [] };
      }
    },
  };
});

import { setupFusionHandlers } from '../fusion-handlers.js';

let vault: string;

function write(relative: string, content: string): void {
  const target = path.join(vault, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function call<T = Record<string, unknown>>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`canal non enregistré : ${channel}`);
  return handler({ sender: { isDestroyed: () => false, send: () => undefined } }, ...args) as Promise<T>;
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-coffre-projet-'));
  h.projectPath = path.join(vault, 'these');
  h.scanned = [];
  fs.mkdirSync(path.join(h.projectPath, '.cliodeck'), { recursive: true });
  fs.writeFileSync(
    path.join(h.projectPath, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name: 'Thèse', vault: { path: vault } })
  );
  setupFusionHandlers();
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('fusion:vault:index — coffre qui contient le projet', () => {
  it('n’indexe ni les notes de lecture ni le manuscrit ; les autres notes restent', async () => {
    write('Journal/2026-11-06.md', '# Journal\n');
    write('these/reading-notes/Braudel_1949.md', '# Braudel\n');
    write('these/document.md', '# Article\n');
    write('these/idees.md', '# Idées\n');

    const res = await call<{ success: boolean; indexed: number }>('fusion:vault:index');

    expect(res.success).toBe(true);
    expect(h.scanned).toEqual(['Journal/2026-11-06.md', 'these/idees.md']);
    expect(res.indexed).toBe(2);
  });
});
