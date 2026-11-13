import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../../llm/providers/base.js';
import { instrumentEmbedding, instrumentLLM } from '../../llm/providers/instrument.js';
import { FallbackEmbeddingProvider, resolveEmbeddingProvider } from '../../llm/providers/fallback.js';
import {
  runBatch,
  setBatchSink,
  setInferenceSink,
} from '../context.js';
import type { BatchAccumulator, JournalContext } from '../context.js';
import type { RecordInferenceInput } from '../types.js';

const READY: ProviderStatus = { state: 'ready' };

class FakeLLM implements LLMProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly capabilities = { chat: true, streaming: true, tools: false, embeddings: false };
  constructor(
    private readonly chunks: ChatChunk[],
    readonly model = 'fake-model'
  ) {}
  getStatus(): ProviderStatus {
    return READY;
  }
  async healthCheck(): Promise<ProviderStatus> {
    return READY;
  }
  // eslint-disable-next-line require-yield
  async *chat(_messages: ChatMessage[]): AsyncIterable<ChatChunk> {
    for (const c of this.chunks) yield c;
  }
  async complete(prompt: string): Promise<string> {
    let out = '';
    for await (const c of this.chat([{ role: 'user', content: prompt }])) out += c.delta;
    return out;
  }
  async dispose(): Promise<void> {}
}

class FakeEmbedding implements EmbeddingProvider {
  readonly id = 'fake-emb';
  readonly name = 'Fake Emb';
  readonly dimension = 3;
  readonly model = 'fake-embed';
  getStatus(): ProviderStatus {
    return READY;
  }
  async healthCheck(): Promise<ProviderStatus> {
    return READY;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0]);
  }
  async dispose(): Promise<void> {}
}

describe('usage-journal provider instrumentation', () => {
  let events: RecordInferenceInput[];
  let batches: Array<{ acc: BatchAccumulator; ctx: JournalContext }>;

  beforeEach(() => {
    events = [];
    batches = [];
    setInferenceSink((e) => events.push(e));
    setBatchSink((acc, ctx) => batches.push({ acc, ctx }));
  });
  afterEach(() => {
    setInferenceSink(undefined);
    setBatchSink(undefined);
  });

  it('emits a completion event with real usage when the backend reports it', async () => {
    const llm = instrumentLLM(
      new FakeLLM([
        { delta: 'hello ' },
        { delta: 'world', done: true, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      ]),
      'anthropic'
    );
    let out = '';
    for await (const c of llm.chat([{ role: 'user', content: 'hi' }])) out += c.delta;
    expect(out).toBe('hello world');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'completion',
      provider: 'anthropic',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      tokensEstimated: false,
      status: 'ok',
    });
  });

  it('estimates tokens (chars/4) when the backend reports no usage', async () => {
    const llm = instrumentLLM(
      new FakeLLM([{ delta: 'abcdefgh', done: true }]), // 8 chars → 2 tokens
      'mistral'
    );
    // prompt "abcd" = 4 chars → 1 token
    const result = await llm.complete('abcd');
    expect(result).toBe('abcdefgh');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'completion',
      provider: 'mistral',
      promptTokens: 1,
      completionTokens: 2,
      tokensEstimated: true,
    });
  });

  it('emits a single embedding event outside a batch scope', async () => {
    const emb = instrumentEmbedding(new FakeEmbedding(), 'ollama');
    await emb.embed(['abcd', 'efgh']); // 2 texts, 8 chars total → 2 tokens
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'embedding',
      provider: 'ollama',
      chunkCount: 2,
      totalTokens: 2,
      tokensEstimated: true,
    });
    expect(batches).toHaveLength(0);
  });

  it('aggregates per-chunk embeds into ONE embedding_batch inside a scope', async () => {
    const emb = instrumentEmbedding(new FakeEmbedding(), 'ollama');
    await runBatch('pdf', async () => {
      await emb.embed(['abcd']); // 1 chunk, 1 token
      await emb.embed(['efghijkl']); // 1 chunk, 2 tokens
    });
    // No per-chunk embedding events…
    expect(events.filter((e) => e.kind === 'embedding')).toHaveLength(0);
    // …one aggregated batch instead.
    expect(batches).toHaveLength(1);
    expect(batches[0].acc).toMatchObject({
      corpus: 'pdf',
      provider: 'ollama',
      chunkCount: 2,
      totalTokens: 3,
      anyError: false,
    });
  });

  it('journalise distant un modèle Ollama hébergé ou un Ollama sur un autre hôte', async () => {
    const isLocal = async (model: string, baseUrl: string): Promise<boolean | undefined> => {
      events.length = 0;
      await instrumentLLM(new FakeLLM([{ delta: 'x', done: true }], model), 'ollama', baseUrl).complete('q');
      return events[0].isLocal;
    };
    expect(await isLocal('llama3.2', 'http://127.0.0.1:11434')).toBe(true);
    expect(await isLocal('gpt-oss:120b-cloud', 'http://127.0.0.1:11434')).toBe(false);
    expect(await isLocal('qwen3.5:cloud', 'http://127.0.0.1:11434')).toBe(false);
    expect(await isLocal('llama3.2', 'http://gpu.labo.example:11434')).toBe(false);
  });

  // Un tour tombé chez le fournisseur se termine par un chunk `error`, sans exception : le journal
  // le comptait « ok » (S05-1-2).
  it('un chat fini par un chunk terminal error est journalisé en erreur', async () => {
    const llm = instrumentLLM(
      new FakeLLM([{ delta: 'Début ' }, { delta: '', done: true, finishReason: 'error' }]),
      'ollama'
    );
    for await (const _ of llm.chat([{ role: 'user', content: 'q' }])) {
      // consommé jusqu'au bout
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'error' });
  });

  it('complete() d’un fournisseur en panne rejette avec la cause, et le journal dit erreur', async () => {
    const failing = new (class extends FakeLLM {
      getStatus(): ProviderStatus {
        return {
          state: 'degraded',
          lastError: { code: 'anthropic_http_401', message: 'invalid x-api-key', at: 'now' },
        };
      }
    })([{ delta: '', done: true, finishReason: 'error' }]);
    const llm = instrumentLLM(failing, 'anthropic');

    await expect(llm.complete('q')).rejects.toMatchObject({
      name: 'ProviderCallError',
      code: 'anthropic_http_401',
      message: 'invalid x-api-key',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'completion', status: 'error' });
  });

  // Une synthèse coupée chez un fournisseur facturé a déjà produit du texte et annoncé son usage :
  // le journal le garde, comme pour un chat() coupé au même endroit (revue de L09-7).
  it('complete() tombé après du texte garde au journal le texte produit et l’usage annoncé', async () => {
    const chunks: ChatChunk[] = [
      { delta: 'x'.repeat(4000), usage: { promptTokens: 1200 } },
      { delta: '', done: true, finishReason: 'error' },
    ];
    await expect(instrumentLLM(new FakeLLM(chunks), 'anthropic').complete('p'.repeat(40))).rejects
      .toMatchObject({ name: 'ProviderCallError' });
    for await (const _ of instrumentLLM(new FakeLLM(chunks), 'anthropic').chat([
      { role: 'user', content: 'p'.repeat(40) },
    ])) {
      // consommé jusqu'au bout
    }

    expect(events).toHaveLength(2);
    const [viaComplete, viaChat] = events;
    expect(viaComplete).toMatchObject({
      status: 'error',
      promptTokens: 1200,
      completionTokens: 1000,
      tokensEstimated: true,
    });
    expect(viaComplete).toMatchObject({
      promptTokens: viaChat.promptTokens,
      completionTokens: viaChat.completionTokens,
    });
  });

  it('un repli enveloppé se résout à travers le décorateur, sans quitter le journal', async () => {
    // Nommés comme les vrais : le secours (le modèle embarqué) est inscrit sous son nom (S10-1-11).
    const named = (id: string, model: string, up: boolean): EmbeddingProvider => {
      const base = new FakeEmbedding();
      return {
        id,
        name: base.name,
        dimension: base.dimension,
        model,
        getStatus: () => READY,
        healthCheck: async () => (up ? READY : { state: 'failed' }),
        embed: (texts) => base.embed(texts),
        dispose: async () => undefined,
      };
    };
    const emb = instrumentEmbedding(
      new FallbackEmbeddingProvider(
        named('ollama-embedding', 'primaire', false),
        named('embedded-embedding', 'secours', true)
      ),
      'ollama'
    );
    const chosen = await resolveEmbeddingProvider(emb);
    expect(chosen.model).toBe('secours');
    await chosen.embed(['abcd']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'embedding', provider: 'embedded', model: 'secours', isLocal: true });

    const plain = instrumentEmbedding(new FakeEmbedding(), 'ollama');
    expect(await resolveEmbeddingProvider(plain)).toBe(plain);
  });
});
