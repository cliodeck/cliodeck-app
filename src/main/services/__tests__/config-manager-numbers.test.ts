/**
 * `cliodeck-config.json` abîmé : la porte est ici, à la lecture, pour tous les lecteurs à la fois.
 * Vrai `ConfigManager`, vrai `conf` (le socle d'electron-store), vrai fichier : le jugement se fait
 * sur les octets. Seul le trousseau est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const place = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron-store', async () => {
  const { default: Conf } = await import('conf');
  return {
    default: class extends Conf<Record<string, unknown>> {
      // Ce que fait electron-store : `name` s'appelle `configName` pour `conf`.
      constructor({ name, ...options }: Record<string, unknown>) {
        super({ ...options, configName: name as string, cwd: place.dir, projectVersion: '1.0.0' });
      }
    },
  };
});
vi.mock('../secure-storage.js', () => ({
  SENSITIVE_KEYS: [],
  secureStorage: {
    init: async () => undefined,
    getKey: () => '',
    setKey: () => undefined,
    deleteKey: () => undefined,
  },
}));

const { ConfigManager } = await import('../config-manager.js');
const { DEFAULT_CONFIG } = await import('../../../../backend/types/config.js');

const file = () => join(place.dir, 'cliodeck-config.json');
const onDisk = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Record<string, unknown>>;

/** La date du fichier, reculée : une écriture se voit même dans la même milliseconde. */
function markUntouched(): number {
  const past = new Date(Date.now() - 60_000);
  utimesSync(file(), past, past);
  return statSync(file()).mtimeMs;
}

async function open(config: unknown): Promise<InstanceType<typeof ConfigManager>> {
  writeFileSync(file(), JSON.stringify(config));
  const manager = new ConfigManager();
  await manager.init();
  return manager;
}

const AUTHOR = {
  language: 'fr',
  recentProjects: [],
  rag: { topK: 7, similarityThreshold: 0.33, chunkingConfig: 'large' },
  llm: { backend: 'ollama', ollamaChatModel: 'qwen3:14b', ollamaNumCtx: 8192, embeddedModelPath: null },
  editor: { fontSize: 15, theme: 'light', wordWrap: true, showMinimap: true, engine: 'cm6' },
};

beforeEach(() => {
  place.dir = mkdtempSync(join(tmpdir(), 'cliodeck-config-nombres-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(place.dir, { recursive: true, force: true });
});

describe('un fichier abîmé', () => {
  it('topK et seuil à null : les services lisent les défauts, jamais un null', async () => {
    const manager = await open({ ...AUTHOR, rag: { ...AUTHOR.rag, topK: null, similarityThreshold: null } });

    expect(manager.getRAGConfig().topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(manager.getRAGConfig().similarityThreshold).toBe(DEFAULT_CONFIG.rag.similarityThreshold);
    expect(manager.getRAGConfig().chunkingConfig).toBe('large');
  });

  it.each([['rag'], ['editor'], ['llm']] as const)('%s : chaque porte de lecture rend la section réparée', async (section) => {
    const damaged = {
      ...AUTHOR,
      rag: { ...AUTHOR.rag, topK: 'abc' },
      llm: { ...AUTHOR.llm, ollamaNumCtx: 'abc' },
      editor: { ...AUTHOR.editor, fontSize: null },
    };
    const clean = {
      rag: { ...AUTHOR.rag, topK: DEFAULT_CONFIG.rag.topK },
      llm: { backend: 'ollama', ollamaChatModel: 'qwen3:14b', embeddedModelPath: null },
      editor: { ...AUTHOR.editor, fontSize: DEFAULT_CONFIG.editor.fontSize },
    };

    const viaGet = await open(damaged);
    expect(viaGet.get(section)).toEqual(clean[section]);

    const viaGetAll = await open(damaged);
    expect(viaGetAll.getAll()[section]).toEqual(clean[section]);

    const viaSecrets = await open(damaged);
    expect(viaSecrets.getAllWithSecrets()[section]).toEqual(clean[section]);
  });

  it('getLLMConfig : une fenêtre illisible n’arrive pas aux fournisseurs', async () => {
    const manager = await open({ ...AUTHOR, llm: { ...AUTHOR.llm, ollamaEmbeddingNumCtx: 'abc' } });
    expect(manager.getLLMConfig()).not.toHaveProperty('ollamaEmbeddingNumCtx');
  });

  it('le fichier est réparé une fois, à la première lecture, et seuls les champs abîmés changent', async () => {
    const manager = await open({
      ...AUTHOR,
      rag: { ...AUTHOR.rag, similarityThreshold: null, customChunkingEnabled: null, inconnu: null },
      editor: { ...AUTHOR.editor, fontSize: '18' },
    });

    manager.getRAGConfig();
    manager.get('editor');

    expect(onDisk().rag).toEqual({
      ...AUTHOR.rag,
      similarityThreshold: DEFAULT_CONFIG.rag.similarityThreshold,
      customChunkingEnabled: null,
      inconnu: null,
    });
    expect(onDisk().editor).toEqual({ ...AUTHOR.editor, fontSize: DEFAULT_CONFIG.editor.fontSize });
    expect(onDisk().llm).toEqual(AUTHOR.llm);

    const repaired = readFileSync(file());
    const mtime = markUntouched();
    manager.getRAGConfig();
    manager.get('rag');
    manager.getAll();
    expect(readFileSync(file()).equals(repaired)).toBe(true);
    expect(statSync(file()).mtimeMs).toBe(mtime);
  });

  it('abîmé pendant que l’app tourne : la lecture suivante le voit et le répare', async () => {
    const manager = await open(AUTHOR);
    writeFileSync(file(), JSON.stringify({ ...AUTHOR, rag: { topK: null } }));

    expect(manager.getRAGConfig().topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(onDisk().rag).toEqual({ topK: DEFAULT_CONFIG.rag.topK });
  });

  it('une écriture refusée : la lecture répond quand même, sans lever', async () => {
    const manager = await open({ ...AUTHOR, rag: { topK: null } });
    const store = (manager as unknown as { _store: { set(...args: unknown[]): void } })._store;
    vi.spyOn(store, 'set').mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(manager.getRAGConfig().topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(console.error).toHaveBeenCalled();
    expect(onDisk().rag).toEqual({ topK: null });
  });

  it('écrire une section d’après une section abîmée n’y laisse pas le null', async () => {
    const manager = await open({ ...AUTHOR, llm: { ...AUTHOR.llm, ollamaNumCtx: null } });
    manager.setLLMConfig({ ollamaChatModel: 'mistral-nemo' });
    expect(onDisk().llm).toEqual({ backend: 'ollama', ollamaChatModel: 'mistral-nemo', embeddedModelPath: null });
  });
});

describe('un fichier sain', () => {
  it('aucune lecture ne le réécrit', async () => {
    const manager = await open(AUTHOR);
    const bytes = readFileSync(file());
    const mtime = markUntouched();

    manager.get('rag');
    manager.get('llm');
    manager.get('editor');
    manager.getRAGConfig();
    manager.getLLMConfig();
    manager.getAll();
    manager.getAllWithSecrets();

    expect(readFileSync(file()).equals(bytes)).toBe(true);
    expect(statSync(file()).mtimeMs).toBe(mtime);
  });
});

describe('un champ absent', () => {
  const FEW = { language: 'fr', recentProjects: [], rag: { topK: 7 }, llm: { backend: 'ollama' }, editor: { fontSize: 15 } };

  it('n’est pas une panne : aucune écriture, et `get` n’invente rien', async () => {
    const manager = await open(FEW);
    const bytes = readFileSync(file());

    expect(manager.get('rag')).toEqual(FEW.rag);
    manager.getRAGConfig();
    manager.getAll();

    expect(readFileSync(file()).equals(bytes)).toBe(true);
  });

  it('les services retombent sur le défaut : c’est ce que `stripNonFinite` laisse derrière lui', async () => {
    const manager = await open({ ...FEW, rag: { chunkingConfig: 'large' } });
    const rag = manager.getRAGConfig();
    expect(rag.topK).toBe(DEFAULT_CONFIG.rag.topK);
    expect(rag.similarityThreshold).toBe(DEFAULT_CONFIG.rag.similarityThreshold);
    expect(rag.chunkingConfig).toBe('large');
    expect(onDisk().rag).toEqual({ chunkingConfig: 'large' });
  });
});
