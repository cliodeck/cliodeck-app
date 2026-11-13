/**
 * Génération embarquée : le texte arrive au fil de l'eau, et « Arrêter » coupe llama.cpp (L09-10).
 *
 * `generateChat` attendait `session.prompt()` jusqu'au bout en accumulant `onTextChunk` dans un
 * tableau, et ne cédait les morceaux qu'ensuite ; aucun signal n'atteignait node-llama-cpp
 * (S05-1-13). Sous macOS 12 ou 13, seul chemin sans Ollama : rien ne s'affichait pendant la
 * génération, « Arrêter » laissait le processeur tourner jusqu'à 2 048 jetons, puis le tour finissait
 * « cancelled » sans un mot, la réponse produite jetée.
 *
 * Les tests passent par le vrai `EmbeddedLLMClient` (et, plus bas, par le fournisseur et le décorateur
 * du journal d'usage, comme l'app) jusqu'au double de `node-llama-cpp`
 * (`helpers/fake-node-llama-cpp.ts`), qui cède ses morceaux pendant que sa promesse court et lit le
 * signal comme le vrai.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLlama } from './helpers/fake-node-llama-cpp.js';

vi.mock('node-llama-cpp', async () => (await import('./helpers/fake-node-llama-cpp.js')).fakeNodeLlamaCpp);

import { EmbeddedLLMClient, type EmbeddedChatRequest } from '../EmbeddedLLMClient.js';
import { EmbeddedProvider } from '../providers/embedded.js';
import { instrumentLLM } from '../providers/instrument.js';
import { setInferenceSink } from '../../usage-journal/context.js';
import type { RecordInferenceInput } from '../../usage-journal/types.js';
import type { ChatChunk } from '../providers/base.js';

/** Une longue réponse : mille morceaux, bien plus que ce qu'un test lit avant d'arrêter. */
const LONG_REPLY = Array.from({ length: 1000 }, (_, i) => `mot${i} `);

const QUESTION: EmbeddedChatRequest = {
  system: 'Réponds en français.',
  history: [],
  prompt: 'Raconte la grève des dockers du Havre en 1910.',
};

async function loadedClient(): Promise<EmbeddedLLMClient> {
  const client = new EmbeddedLLMClient();
  expect(await client.initialize('/modeles/qwen.gguf', 'qwen2.5-0.5b')).toBe(true);
  return client;
}

/** La génération suivante, sur le même client : elle part, et rend toute sa réponse. */
async function nextGenerationRuns(client: EmbeddedLLMClient): Promise<void> {
  fakeLlama.reply = ['Une ', 'réponse.'];
  let text = '';
  for await (const chunk of client.generateChat(QUESTION)) text += chunk;
  expect(text).toBe('Une réponse.');
}

beforeEach(() => {
  fakeLlama.reset();
  fakeLlama.reply = [...LONG_REPLY];
});

describe('EmbeddedLLMClient.generateChat — au fil de la génération', () => {
  it('le premier morceau est cédé pendant que la génération court, et la réponse arrive entière', async () => {
    const client = await loadedClient();
    let settledAtFirstChunk: boolean | undefined;
    let text = '';
    for await (const chunk of client.generateChat(QUESTION)) {
      settledAtFirstChunk ??= fakeLlama.sessions[0].prompts[0].settled;
      text += chunk;
    }

    expect(settledAtFirstChunk).toBe(false);
    expect(text).toBe(LONG_REPLY.join(''));
    expect(fakeLlama.sessions[0].disposed).toEqual({ disposeSequence: false });
    await client.dispose();
  });

  it('« Arrêter » : llama.cpp s’arrête au morceau suivant, le générateur finit, et la génération suivante part', async () => {
    const client = await loadedClient();
    const controller = new AbortController();
    const received: string[] = [];
    for await (const chunk of client.generateChat({ ...QUESTION, signal: controller.signal })) {
      received.push(chunk);
      if (received.length === 3) controller.abort();
    }

    const [call] = fakeLlama.sessions[0].prompts;
    // Le moteur s'est arrêté : au plus le morceau en cours quand le signal est tombé.
    expect(call.emitted).toBeLessThanOrEqual(4);
    expect(call.options.stopOnAbortSignal).toBe(true);
    expect(call.options.signal?.aborted).toBe(true);
    expect(received.slice(0, 3)).toEqual(LONG_REPLY.slice(0, 3));
    expect(call.settled).toBe(true);
    // La session part avec la génération ; la séquence reste au client.
    expect(fakeLlama.sessions[0].disposed).toEqual({ disposeSequence: false });

    await nextGenerationRuns(client);
    await client.dispose();
  });

  it('le consommateur quitte l’itération : llama.cpp s’arrête aussi, la session part, et la génération suivante part', async () => {
    const client = await loadedClient();
    for await (const chunk of client.generateChat(QUESTION)) {
      expect(chunk).toBe(LONG_REPLY[0]);
      break;
    }

    const [call] = fakeLlama.sessions[0].prompts;
    expect(call.emitted).toBeLessThanOrEqual(2);
    expect(call.settled).toBe(true);
    expect(fakeLlama.sessions[0].disposed).toEqual({ disposeSequence: false });

    await nextGenerationRuns(client);
    await client.dispose();
  });
});

describe('EmbeddedProvider.chat — arrêté pendant la génération', () => {
  let events: RecordInferenceInput[];

  beforeEach(() => {
    events = [];
    setInferenceSink((e) => events.push(e));
  });
  afterEach(() => {
    setInferenceSink(undefined);
  });

  /** Le tour, comme l'app le mène : fournisseur enveloppé par le décorateur du journal d'usage. */
  function turn(provider: EmbeddedProvider, signal: AbortSignal): Promise<ChatChunk[]> {
    const llm = instrumentLLM(provider, 'embedded');
    return (async () => {
      const chunks: ChatChunk[] = [];
      for await (const chunk of llm.chat([{ role: 'user', content: QUESTION.prompt }], { signal })) {
        chunks.push(chunk);
      }
      return chunks;
    })();
  }

  it('au milieu de la réponse : terminal cancelled après le texte déjà émis, sans panne, et le journal compte ce texte', async () => {
    const provider = new EmbeddedProvider({ modelPath: '/modeles/qwen.gguf', modelId: 'qwen2.5-0.5b' });
    const controller = new AbortController();
    const writing = fakeLlama.whenEmitted(3);

    const chunks = turn(provider, controller.signal);
    await writing;
    controller.abort();
    const received = await chunks;

    const text = received.map((c) => c.delta).join('');
    expect(text.length).toBeGreaterThan(0);
    expect(LONG_REPLY.join('').startsWith(text)).toBe(true);
    expect(received.at(-1)).toEqual({ delta: '', done: true, finishReason: 'cancelled' });
    expect(fakeLlama.sessions[0].prompts[0].emitted).toBeLessThanOrEqual(4);
    // Un arrêt n'est pas une panne : le fournisseur reste prêt pour la question suivante.
    expect(provider.getStatus()).toMatchObject({ state: 'ready' });
    expect(provider.getStatus().lastError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'completion',
      provider: 'embedded',
      status: 'cancelled',
      completionTokens: Math.ceil(text.length / 4),
    });

    // La question suivante répond normalement.
    fakeLlama.reply = ['Une ', 'réponse.'];
    const next = await turn(provider, new AbortController().signal);
    expect(next.map((c) => c.delta).join('')).toBe('Une réponse.');
    expect(next.at(-1)).toEqual({ delta: '', done: true, finishReason: 'stop' });
    expect(events.at(-1)).toMatchObject({ status: 'ok' });
    await provider.dispose();
  });

  // Le modèle lit encore les consignes (le préremplissage) : node-llama-cpp lève la raison du signal,
  // `stopOnAbortSignal` ou non, puisqu'il n'a rien à rendre. Le double ne simule pas la durée de la
  // lecture : le vrai moteur ne lit le signal qu'à sa fin, mesuré dans EmbeddedLLMClient.live.test.ts.
  it('avant le premier morceau : terminal cancelled, ni degraded ni cause, et rien de produit', async () => {
    const provider = new EmbeddedProvider({ modelPath: '/modeles/qwen.gguf', modelId: 'qwen2.5-0.5b' });
    const controller = new AbortController();
    const started = fakeLlama.whenEmitted(0);

    const chunks = turn(provider, controller.signal);
    await started;
    controller.abort();
    const received = await chunks;

    expect(fakeLlama.sessions[0].prompts[0].emitted).toBe(0);
    expect(received).toEqual([{ delta: '', done: true, finishReason: 'cancelled' }]);
    expect(provider.getStatus()).toMatchObject({ state: 'ready' });
    expect(provider.getStatus().lastError).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'cancelled', completionTokens: undefined });
    await provider.dispose();
  });
});
