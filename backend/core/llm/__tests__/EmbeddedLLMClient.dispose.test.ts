/**
 * Libérer le moteur embarqué libère aussi ses modèles, et jamais le backend du processus (L03-9, A16).
 *
 * `dispose()` libérait les contextes mais oubliait les modèles : le GGUF restait chargé, sur Metal,
 * jusqu'à la sortie du processus, et sortir avec un modèle chargé fait planter l'app à la fermeture
 * (rapport `.ips`, mesuré par les sondes). `llama.dispose()`, lui, ne doit jamais être appelé : il
 * libère un backend global au processus, celui de tous les autres clients (mesuré par L08).
 *
 * Et à la sortie, tout client qui tient encore un modèle est libéré, même celui d'un appel en cours
 * hors du projet (similarité, diapositives) que personne d'autre ne libérerait à temps.
 *
 * Aucun GGUF n'est chargé : `node-llama-cpp` est remplacé par un double qui inscrit chaque
 * libération dans `engine.disposed`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => {
  const disposed: string[] = [];
  return {
    disposed,
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
            engine.disposed.push('embeddingContext');
          },
        }),
      };
    },
  };
  return { getLlama: async () => llama };
});

import { EmbeddedLLMClient } from '../EmbeddedLLMClient.js';
import { disposeAllEmbeddedClients } from '../embedded-engine-pool.js';

async function loadedClient(): Promise<EmbeddedLLMClient> {
  const client = new EmbeddedLLMClient();
  expect(await client.initialize('/modeles/qwen.gguf', 'qwen')).toBe(true);
  expect(await client.initializeEmbedding('/modeles/nomic-embed.gguf', 'nomic')).toBe(true);
  return client;
}

beforeEach(async () => {
  // Un test précédent a pu laisser un client chargé : il ne doit pas compter dans le suivant.
  await disposeAllEmbeddedClients();
  engine.disposed.length = 0;
  engine.llamaDispose.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
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

  it('un client déjà libéré n’est pas libéré de nouveau', async () => {
    const client = await loadedClient();
    await client.dispose();
    engine.disposed.length = 0;

    await disposeAllEmbeddedClients();

    expect(engine.disposed).toEqual([]);
  });
});
