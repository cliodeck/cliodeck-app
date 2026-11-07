/**
 * Le service Tropy au changement de projet : le moteur OCR de la synchro (un
 * thread, le WASM de Tesseract et son modèle de langue) n'était jamais libéré.
 * `init()` remplaçait le TropySync sans `dispose()`, `close()` l'oubliait ; seul
 * le pipeline de l'OCR manuel l'était (S08-1-16). Et sans dossier de modèles,
 * tesseract.js les rangeait dans le dossier courant : `/` pour l'app lancée du
 * Finder, non inscriptible, d'où le réseau exigé à chaque session (S08-1-29).
 *
 * Vrai `tropyService` ; simulés : Electron, la configuration, le magasin SQLite,
 * la synchro, le watcher, le pipeline OCR et les fournisseurs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

const USER_DATA = '/tmp/userdata-de-test';

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => USER_DATA },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    getLLMConfig: () => ({ backend: 'ollama', ollamaURL: 'http://127.0.0.1:1' }),
    getRAGConfig: () => ({ similarityThreshold: 0 }),
    getAPIKey: () => '',
    get: () => undefined,
    set: () => undefined,
  },
}));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', () => ({
  createRegistryFromClioDeckConfig: () => ({
    getLLM: () => null,
    getEmbedding: () => null,
    dispose: async () => undefined,
  }),
}));

vi.mock('../../../../backend/core/vector-store/PrimarySourcesVectorStore.js', () => ({
  PrimarySourcesVectorStore: class {
    getTropyProject = () => null;
    close = () => undefined;
  },
}));

const created = vi.hoisted(() => ({
  syncs: [] as Array<{ options: unknown; dispose: ReturnType<typeof vi.fn> }>,
  pipelines: [] as Array<{ options: unknown; dispose: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../../../../backend/integrations/tropy/TropySync.js', () => ({
  TropySync: class {
    dispose = vi.fn(async () => undefined);
    constructor(options?: unknown) {
      created.syncs.push({ options, dispose: this.dispose });
    }
  },
}));

vi.mock('../../../../backend/integrations/tropy/TropyWatcher.js', () => ({
  TropyWatcher: class {
    removeAllListeners = () => undefined;
    unwatch = () => undefined;
  },
}));

vi.mock('../../../../backend/integrations/tropy/TropyOCRPipeline.js', () => ({
  TropyOCRPipeline: class {
    dispose = vi.fn(async () => undefined);
    constructor(options?: unknown) {
      created.pipelines.push({ options, dispose: this.dispose });
    }
  },
  SUPPORTED_OCR_LANGUAGES: [],
}));

const { tropyService } = await import('../tropy-service.js');

beforeEach(() => {
  created.syncs.length = 0;
  created.pipelines.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await tropyService.close();
  vi.restoreAllMocks();
});

describe('tropyService : le moteur OCR de la synchro suit le projet (L06-10, S08-1-16)', () => {
  it('ouvrir B après A libère la synchro de A', async () => {
    await tropyService.init('/projets/A');
    await tropyService.init('/projets/B');

    expect(created.syncs).toHaveLength(2);
    expect(created.syncs[0].dispose).toHaveBeenCalledTimes(1);
    expect(created.syncs[1].dispose).not.toHaveBeenCalled();
  });

  it('fermer le projet libère sa synchro', async () => {
    await tropyService.init('/projets/A');
    await tropyService.close();

    expect(created.syncs[0].dispose).toHaveBeenCalledTimes(1);
  });
});

describe('tropyService : un dossier de modèles à soi (L06-10, S08-1-29)', () => {
  it('synchro et OCR manuel rangent les modèles de langue sous userData', async () => {
    await tropyService.init('/projets/A');

    const cachePath = path.join(USER_DATA, 'tesseract-cache');
    expect(created.syncs[0].options).toEqual({ cachePath });
    expect(created.pipelines.map((p) => p.options)).toEqual([{ cachePath }]);
  });
});
