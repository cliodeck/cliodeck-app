/**
 * Libérer le moteur embarqué libère aussi ses modèles, et jamais le backend du processus (L03-9, A16).
 *
 * `dispose()` libérait les contextes mais oubliait les modèles : le GGUF restait chargé, sur Metal,
 * jusqu'à la sortie du processus, et sortir avec un modèle chargé fait planter l'app à la fermeture
 * (rapport `.ips`, mesuré par les sondes). `llama.dispose()`, lui, ne doit jamais être appelé : il
 * libère un backend global au processus, celui de tous les autres clients (mesuré par L08).
 *
 * Et à la sortie, tout client qui tient encore un modèle est libéré, même celui d'un appel en cours
 * hors du projet (similarité, diapositives) que personne d'autre ne libérerait à temps. Un modèle en
 * cours de chargement compte aussi : l'écriture du flush de sortie lance l'indexation du manuscrit,
 * qui peut charger le modèle d'embedding pendant que la sortie libère tout.
 *
 * Aucun GGUF n'est chargé : `node-llama-cpp` est remplacé par un double qui inscrit chaque
 * chargement dans `engine.loaded` et chaque libération dans `engine.disposed`. Le suivi des clients
 * est un état du module, et la sortie le ferme pour de bon : chaque test repart de modules neufs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ClientModule from '../EmbeddedLLMClient.js';
import type * as PoolModule from '../embedded-engine-pool.js';

const engine = vi.hoisted(() => {
  const disposed: string[] = [];
  return {
    disposed,
    /** Les modèles dont le chargement a commencé. */
    loaded: [] as string[],
    /** Quand elle est posée, le chargement d'un modèle l'attend : un chargement qui dure. */
    loadGate: null as null | Promise<void>,
    /** Quand elle est posée, la libération d'un contexte d'embedding l'attend : une libération qui dure. */
    embeddingContextGate: null as null | Promise<void>,
    llamaDispose: vi.fn(async () => {
      disposed.push('llama');
    }),
  };
});

vi.mock('node-llama-cpp', () => {
  const llama = {
    dispose: engine.llamaDispose,
    loadModel: async ({ modelPath }: { modelPath: string }) => {
      const name = modelPath.includes('embed') ? 'embeddingModel' : 'model';
      engine.loaded.push(name);
      await engine.loadGate;
      return {
        embeddingVectorSize: 2,
        dispose: async () => {
          engine.disposed.push(name);
        },
        createContext: async () => ({
          getSequence: () => ({}),
          dispose: async () => {
            engine.disposed.push('context');
          },
        }),
        createEmbeddingContext: async () => ({
          getEmbeddingFor: async () => ({ vector: [1, 0] }),
          dispose: async () => {
            await engine.embeddingContextGate;
            engine.disposed.push('embeddingContext');
          },
        }),
      };
    },
  };
  return { getLlama: async () => llama };
});

let EmbeddedLLMClient: typeof ClientModule.EmbeddedLLMClient;
let disposeAllEmbeddedClients: typeof PoolModule.disposeAllEmbeddedClients;

/** Une barrière : ce qui l'attend reste en suspens jusqu'à `open()`. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Laisse courir tout ce qui peut avancer sans franchir une barrière. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadedClient(): Promise<ClientModule.EmbeddedLLMClient> {
  const client = new EmbeddedLLMClient();
  expect(await client.initialize('/modeles/qwen.gguf', 'qwen')).toBe(true);
  expect(await client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic')).toBe(true);
  return client;
}

beforeEach(async () => {
  // Un suivi neuf : celui d'un test précédent, fermé par sa sortie, refuserait tout chargement.
  vi.resetModules();
  ({ EmbeddedLLMClient } = await import('../EmbeddedLLMClient.js'));
  ({ disposeAllEmbeddedClients } = await import('../embedded-engine-pool.js'));
  engine.disposed.length = 0;
  engine.loaded.length = 0;
  engine.loadGate = null;
  engine.embeddingContextGate = null;
  engine.llamaDispose.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('EmbeddedLLMClient.dispose', () => {
  it('libère chaque modèle après son contexte, et jamais le backend llama', async () => {
    const client = await loadedClient();

    await client.dispose();

    expect(engine.disposed).toEqual(['embeddingContext', 'embeddingModel', 'context', 'model']);
    expect(engine.llamaDispose).not.toHaveBeenCalled();
    expect(client.isInitialized()).toBe(false);
  });

  it('deux libérations concurrentes (le registre et la sortie) ne libèrent chaque objet qu’une fois', async () => {
    const client = await loadedClient();

    await Promise.all([client.dispose(), client.dispose()]);

    expect(engine.disposed.sort()).toEqual(['context', 'embeddingContext', 'embeddingModel', 'model']);
  });

  it('une libération attend le modèle en cours de chargement, et le libère', async () => {
    // Un registre se ferme (bascule, `retrievalService.clear`) pendant qu'un appel charge son modèle.
    const loading = gate();
    engine.loadGate = loading.promise;
    const client = new EmbeddedLLMClient();
    const load = client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic');
    await settle();
    let disposed = false;
    const release = client.dispose().then(() => {
      disposed = true;
    });

    await settle();
    // Rendre la main maintenant laisserait le modèle se charger après la libération.
    expect(disposed).toBe(false);
    loading.open();
    await release;

    expect(await load).toBe(true);
    expect(engine.disposed).toEqual(['embeddingContext', 'embeddingModel']);
    expect(client.isEmbeddingAvailable()).toBe(false);
  });

  it('un modèle rechargé pendant une libération est libéré par l’appel qui suit, sans réutiliser l’ancienne libération', async () => {
    const client = await loadedClient();
    const releasing = gate();
    engine.embeddingContextGate = releasing.promise;
    // Le registre libère le client ; sa libération dure.
    const first = client.dispose();
    await settle();
    // Un travail encore en vol recharge le modèle d'embedding pendant ce temps.
    expect(await client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic')).toBe(true);
    // La sortie libère à son tour.
    const second = client.dispose();
    releasing.open();
    await Promise.all([first, second]);

    expect(engine.disposed.filter((d) => d === 'embeddingModel')).toHaveLength(2);
    expect(engine.disposed.filter((d) => d === 'model')).toHaveLength(1);
    expect(client.isEmbeddingAvailable()).toBe(false);
    expect(engine.llamaDispose).not.toHaveBeenCalled();
  });
});

describe('disposeAllEmbeddedClients — la sortie', () => {
  it('libère les modèles de tout client encore chargé, sans toucher au backend llama', async () => {
    // Un appel hors projet en cours à la sortie : personne d'autre ne le libère.
    await loadedClient();
    await loadedClient();

    await disposeAllEmbeddedClients();

    expect(engine.disposed.filter((d) => d === 'model')).toHaveLength(2);
    expect(engine.disposed.filter((d) => d === 'embeddingModel')).toHaveLength(2);
    expect(engine.llamaDispose).not.toHaveBeenCalled();
  });

  it('une libération déjà commencée ailleurs (un registre coupé par son délai) est attendue jusqu’à son terme', async () => {
    const client = await loadedClient();
    const releasing = gate();
    engine.embeddingContextGate = releasing.promise;
    // Le registre d'un service du projet libère ce client, et la sortie ne l'attend plus.
    const elsewhere = client.dispose();
    let releasedAtExit: string[] | null = null;
    const exit = disposeAllEmbeddedClients().then(() => {
      releasedAtExit = [...engine.disposed];
    });

    await settle();
    // La libération en cours n'a pas fini : la sortie ne rend pas la main avant elle.
    expect(releasedAtExit).toBeNull();
    releasing.open();
    await exit;

    expect(releasedAtExit).toEqual(expect.arrayContaining(['embeddingModel', 'model']));
    await elsewhere;
    // Une seule libération de chaque objet, partagée par les deux appels.
    expect(engine.disposed.sort()).toEqual(['context', 'embeddingContext', 'embeddingModel', 'model']);
    expect(engine.llamaDispose).not.toHaveBeenCalled();
  });

  it('un client déjà libéré n’est pas libéré de nouveau', async () => {
    const client = await loadedClient();
    await client.dispose();
    engine.disposed.length = 0;

    await disposeAllEmbeddedClients();

    expect(engine.disposed).toEqual([]);
  });

  it('un modèle en cours de chargement est attendu, puis libéré, avant que la sortie rende la main', async () => {
    // L'écriture du flush de sortie lance l'indexation du manuscrit, qui charge le modèle d'embedding.
    const loading = gate();
    engine.loadGate = loading.promise;
    const client = new EmbeddedLLMClient();
    const load = client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic');
    await settle();
    let releasedAtExit: string[] | null = null;
    const exit = disposeAllEmbeddedClients().then(() => {
      releasedAtExit = [...engine.disposed];
    });

    await settle();
    // Le suivi n'est pas vide : la sortie ne quitte pas avant la fin de ce chargement.
    expect(releasedAtExit).toBeNull();
    loading.open();
    await exit;

    expect(releasedAtExit).toEqual(['embeddingContext', 'embeddingModel']);
    expect(await load).toBe(true);
    expect(client.isEmbeddingAvailable()).toBe(false);
    expect(engine.llamaDispose).not.toHaveBeenCalled();
  });

  it('une fois la sortie commencée, plus aucun modèle ne se charge', async () => {
    await disposeAllEmbeddedClients();

    // Un travail encore en vol (l'indexation relancée par un registre libéré) redemande le modèle.
    const client = new EmbeddedLLMClient();
    expect(await client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic')).toBe(false);
    expect(await client.initialize('/modeles/qwen.gguf', 'qwen')).toBe(false);

    expect(engine.loaded).toEqual([]);
    expect(client.isEmbeddingAvailable()).toBe(false);
  });
});
