/**
 * Embeddings embarqués : un extrait plus long que la fenêtre du modèle doit
 * être vectorisé quand même.
 *
 * Nomic Embed v2 n'accepte que 512 jetons, et un extrait de 300 mots en fait
 * couramment 600 à 700. Le client mesurait la longueur en caractères (seuil
 * de 2 000) : le moteur refusait l'entrée, et l'indexation du PDF entier
 * échouait. Mesuré sur 39 PDF réels : 33 ne s'indexaient pas. Le défaut ne se
 * voyait pas tant qu'Ollama, qui tronque en silence, était là.
 *
 * Aucun GGUF n'est chargé : `node-llama-cpp` est remplacé par un double dont
 * le moteur refuse, comme le vrai, toute entrée plus longue que sa fenêtre.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WINDOW = 20;
const OVERFLOW =
  'Input is longer than the context size. Try to increase the context size or use another model that supports longer contexts.';
const words = (text: string) => text.split(/\s+/).filter(Boolean);

const engine = vi.hoisted(() => ({
  seen: [] as string[],
  withTokenizer: true,
  failWith: null as Error | null,
}));

vi.mock('node-llama-cpp', () => ({
  getLlama: async () => ({
    loadModel: async () => ({
      trainContextSize: 20,
      embeddingVectorSize: 2,
      ...(engine.withTokenizer ? { tokenize: (text: string) => text.split(/\s+/).filter(Boolean) } : {}),
      createEmbeddingContext: async () => ({
        getEmbeddingFor: async (input: string) => {
          if (engine.failWith) throw engine.failWith;
          const count = input.split(/\s+/).filter(Boolean).length;
          if (count > 20) {
            throw new Error(
              'Input is longer than the context size. Try to increase the context size or use another model that supports longer contexts.'
            );
          }
          engine.seen.push(input);
          return { vector: [count, 1] };
        },
        dispose: async () => undefined,
      }),
    }),
  }),
}));

import { EmbeddedLLMClient } from '../EmbeddedLLMClient.js';

async function loadedClient(): Promise<EmbeddedLLMClient> {
  const client = new EmbeddedLLMClient();
  expect(await client.initializeEmbedding('/modeles/nomic.gguf', 'nomic-embed-text-v2')).toBe(true);
  return client;
}

/** `n` mots distincts, courts : bien sous 2 000 caractères même à 60 mots. */
const text = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(' ');

/** Ce que le moteur a reçu, préfixe de tâche retiré. */
const embeddedWords = () => engine.seen.flatMap((input) => words(input).slice(1));

beforeEach(() => {
  engine.seen = [];
  engine.withTokenizer = true;
  engine.failWith = null;
});

describe('EmbeddedLLMClient — embeddings', () => {
  it('vectorise d’un seul tenant un texte qui tient dans la fenêtre', async () => {
    const client = await loadedClient();
    const vector = await client.generateEmbedding(text(5));

    expect(engine.seen).toEqual([`search_document: ${text(5)}`]);
    expect(Array.from(vector)).toEqual([6, 1]);
  });

  it('vectorise un extrait trop long pour la fenêtre, alors qu’il est court en caractères', async () => {
    const long = text(60);
    expect(long.length).toBeLessThan(2000); // l'ancien seuil le laissait passer tel quel
    const client = await loadedClient();

    const vector = await client.generateEmbedding(long);

    expect(vector).toHaveLength(2);
    expect(engine.seen.length).toBeGreaterThan(1);
    for (const input of engine.seen) expect(words(input).length).toBeLessThanOrEqual(WINDOW);
  });

  it('ne perd aucun mot en découpant, et garde leur ordre', async () => {
    const long = text(60);
    const client = await loadedClient();

    await client.generateEmbedding(long);

    expect(embeddedWords()).toEqual(words(long));
  });

  it('rend la moyenne des morceaux', async () => {
    const client = await loadedClient();
    const vector = await client.generateEmbedding(text(60));

    const counts = engine.seen.map((input) => words(input).length);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(vector[0]).toBeCloseTo(mean, 5);
    expect(vector[1]).toBe(1);
  });

  it('s’en sort sans tokeniseur, en se fiant au refus du moteur', async () => {
    engine.withTokenizer = false;
    const long = text(60);
    const client = await loadedClient();

    await expect(client.generateEmbedding(long)).resolves.toHaveLength(2);
    expect(embeddedWords()).toEqual(words(long));
  });

  it('vectorise aussi une question plus longue que la fenêtre', async () => {
    const client = await loadedClient();

    await expect(client.generateQueryEmbedding(text(45))).resolves.toHaveLength(2);
    expect(engine.seen.every((input) => input.startsWith('search_query: '))).toBe(true);
  });

  it('laisse remonter toute autre erreur du moteur', async () => {
    const client = await loadedClient();
    engine.failWith = new Error('boom');

    await expect(client.generateEmbedding(text(5))).rejects.toThrow('boom');
    expect(OVERFLOW).not.toContain('boom');
  });
});
