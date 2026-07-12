import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../../llm/providers/base.js';
import { instrumentEmbedding, instrumentLLM } from '../../llm/providers/instrument.js';
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
  readonly model = 'fake-model';
  readonly capabilities = { chat: true, streaming: true, tools: false, embeddings: false };
  constructor(private readonly chunks: ChatChunk[]) {}
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
});
