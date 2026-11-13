/**
 * Journal d'usage IA : l'issue réelle d'un appel (S05-1-17, S06-2-5, J9).
 *
 * Le contrat de `base.ts` interdit au `chat()` d'un fournisseur de lever une fois le flux commencé :
 * une panne ou un abandon finit par un chunk terminal `error` ou `cancelled`. L09-7 a fait d'un
 * terminal `error` une erreur au journal ; un appel annulé restait « ok », et un embedding abandonné
 * passait pour une panne (« error »), faute d'une valeur pour le dire. Un journal conçu pour être
 * publié (ADR 0007) doit distinguer les trois.
 *
 * Vrais `instrumentLLM`, `instrumentEmbedding` et `context.ts` ; seuls les fournisseurs enveloppés
 * sont simulés, et le sink garde les événements reçus.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../../llm/providers/base.js';
import { instrumentEmbedding, instrumentLLM } from '../../llm/providers/instrument.js';
import { setInferenceSink } from '../context.js';
import type { RecordInferenceInput } from '../types.js';

const READY: ProviderStatus = { state: 'ready' };
const QUESTION: ChatMessage[] = [{ role: 'user', content: 'p'.repeat(400) }];

/** Un fournisseur dont le `chat()` rend ces chunks, puis, s'il le faut, lève. */
function scripted(chunks: ChatChunk[], thenThrow?: () => Error): LLMProvider {
  return {
    id: 'fake',
    name: 'Fake',
    model: 'fake-model',
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    // eslint-disable-next-line require-yield
    async *chat(_messages: ChatMessage[], _opts?: ChatOptions): AsyncIterable<ChatChunk> {
      for (const chunk of chunks) yield chunk;
      if (thenThrow) throw thenThrow();
    },
    complete: async () => '',
  };
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<void> {
  for await (const _ of stream) {
    // consommé jusqu'au bout
  }
}

let events: RecordInferenceInput[];

beforeEach(() => {
  events = [];
  setInferenceSink((e) => events.push(e));
});
afterEach(() => {
  setInferenceSink(undefined);
});

describe('chat() : le statut vient du chunk terminal', () => {
  it('terminal cancelled : « cancelled », pas « ok »', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: 'Début' }, { delta: '', done: true, finishReason: 'cancelled' }]),
      'ollama'
    );
    await drain(llm.chat(QUESTION));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'cancelled' });
  });

  it('terminal error : « error » (déjà vrai depuis L09-7, témoin)', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: 'Début' }, { delta: '', done: true, finishReason: 'error' }]),
      'ollama'
    );
    await drain(llm.chat(QUESTION));
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'error' });
  });

  it('fin par la limite de longueur : « ok », la réponse est là', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: 'Réponse coupée' }, { delta: '', done: true, finishReason: 'length' }]),
      'ollama'
    );
    await drain(llm.chat(QUESTION));
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'ok' });
  });

  it('un fournisseur qui lève sur un abandon : « cancelled » ; sans abandon : « error »', async () => {
    const abort = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const controller = new AbortController();
    controller.abort();
    const cancelled = instrumentLLM(scripted([], abort), 'ollama');
    await expect(drain(cancelled.chat(QUESTION, { signal: controller.signal }))).rejects.toThrow('aborted');

    const broken = instrumentLLM(scripted([], () => new Error('socket hang up')), 'ollama');
    await expect(drain(broken.chat(QUESTION))).rejects.toThrow('socket hang up');

    expect(events.map((e) => e.status)).toEqual(['cancelled', 'error']);
  });

  // Une requête refusée avant toute réponse (Ollama arrêté, clé expirée, « Arrêter » pendant la
  // lecture du prompt) : le fournisseur n'a peut-être rien reçu. Estimer le prompt inventait une
  // consommation (S06-2-5).
  it('tombé ou annulé sans rien produire ni annoncer : aucun jeton estimé', async () => {
    for (const finishReason of ['error', 'cancelled'] as const) {
      await drain(instrumentLLM(scripted([{ delta: '', done: true, finishReason }]), 'anthropic').chat(QUESTION));
    }
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.promptTokens).toBeUndefined();
      expect(event.completionTokens).toBeUndefined();
      expect(event.totalTokens).toBeUndefined();
      expect(event.tokensEstimated).toBe(false);
    }
  });

  it('annulé après un raisonnement : il a produit, les jetons restent estimés', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: '', thinking: 'Je réfléchis…' }, { delta: '', done: true, finishReason: 'cancelled' }]),
      'ollama'
    );
    await drain(llm.chat(QUESTION));
    expect(events[0]).toMatchObject({ status: 'cancelled', promptTokens: 100, tokensEstimated: true });
  });

  it('témoin : un appel réussi sans texte (appel d’outil seul) garde le prompt estimé', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: '', done: true, finishReason: 'stop' }]),
      'mistral'
    );
    await drain(llm.chat(QUESTION));
    expect(events[0]).toMatchObject({ status: 'ok', promptTokens: 100, tokensEstimated: true });
  });
});

describe('complete() : les appels rendus d’un bloc', () => {
  it('annulé : rejette, et « cancelled » au journal', async () => {
    const llm = instrumentLLM(
      scripted([{ delta: 'Début', done: true, finishReason: 'cancelled' }]),
      'ollama'
    );
    await expect(llm.complete('q')).rejects.toMatchObject({ name: 'ProviderCallError', finishReason: 'cancelled' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'cancelled' });
  });

  it('en panne avant tout texte : « error », sans jeton estimé', async () => {
    const llm = instrumentLLM(scripted([{ delta: '', done: true, finishReason: 'error' }]), 'anthropic');
    await expect(llm.complete('p'.repeat(400))).rejects.toMatchObject({ name: 'ProviderCallError' });
    expect(events[0]).toMatchObject({ status: 'error', tokensEstimated: false });
    expect(events[0].promptTokens).toBeUndefined();
  });
});

describe('embed() : un abandon n’est pas une panne', () => {
  /** Un fournisseur qui, comme `fetch`, rejette par la raison du signal quand on l'abandonne. */
  function abortable(): EmbeddingProvider {
    return {
      id: 'fake-emb',
      name: 'Fake Emb',
      dimension: 3,
      model: 'fake-embed',
      getStatus: () => READY,
      healthCheck: async () => READY,
      dispose: async () => undefined,
      embed: (_texts, opts) =>
        new Promise<number[][]>((_resolve, reject) => {
          const signal = opts?.signal;
          if (!signal) {
            reject(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
  }

  it('abandonné : « cancelled » ; refusé par le fournisseur : « error »', async () => {
    const embedder = instrumentEmbedding(abortable(), 'ollama', 'http://127.0.0.1:11434');
    const controller = new AbortController();
    const pending = embedder.embed(['texte'], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await expect(embedder.embed(['texte'])).rejects.toThrow('ECONNREFUSED');

    expect(events.map((e) => [e.kind, e.status])).toEqual([
      ['embedding', 'cancelled'],
      ['embedding', 'error'],
    ]);
  });
});
