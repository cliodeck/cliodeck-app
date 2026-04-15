import { describe, it, expect } from 'vitest';
import { runChatTurn, type ChatEngineRetriever } from '../chat-engine.js';
import type {
  ChatChunk,
  ChatMessage,
  LLMProvider,
} from '../../../../backend/core/llm/providers/base.js';
import type { RAGExplanation } from '../../../../backend/types/chat-source.js';

function makeFakeProvider(chunks: ChatChunk[]): LLMProvider {
  return {
    id: 'fake',
    name: 'Fake Provider',
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => ({ state: 'ready' }) as never,
    healthCheck: async () => ({ state: 'ready' }) as never,
    chat: async function* (_: ChatMessage[]) {
      for (const c of chunks) yield c;
    },
    complete: async () => '',
    dispose: async () => undefined,
  } as unknown as LLMProvider;
}

describe('chat-engine onExplanation', () => {
  it('emits a RAGExplanation when the retriever provides stats', async () => {
    const provider = makeFakeProvider([
      { delta: 'hello', done: false },
      {
        delta: '',
        done: true,
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
      },
    ]);

    const retriever: ChatEngineRetriever<{ title: string }> = {
      async search() {
        return {
          systemPrompt: 'CTX',
          sources: [{ title: 'doc A' }],
          explanation: {
            search: {
              query: 'q',
              totalResults: 1,
              searchDurationMs: 3,
              cacheHit: false,
              sourceType: 'both',
              documents: [
                {
                  title: 'doc A',
                  similarity: 0.9,
                  sourceType: 'secondary',
                  chunkCount: 1,
                },
              ],
            },
            timing: { searchMs: 3 },
          },
        };
      },
    };

    let captured: RAGExplanation | null = null;
    let sawDone = false;
    await runChatTurn<{ title: string }>({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      retriever,
      hooks: {
        onExplanation: (e) => {
          captured = e;
        },
        onDone: () => {
          sawDone = true;
        },
      },
    });

    expect(sawDone).toBe(true);
    expect(captured).not.toBeNull();
    const exp = captured as unknown as RAGExplanation;
    expect(exp.search.query).toBe('q');
    expect(exp.search.totalResults).toBe(1);
    expect(exp.llm.provider).toBe('fake');
    expect(exp.timing.searchMs).toBe(3);
    expect(exp.timing.generationMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards retrievalOptions to the retriever verbatim', async () => {
    const provider = makeFakeProvider([
      { delta: '', done: true, finishReason: 'stop' },
    ]);
    let seen: unknown = null;
    const retriever: ChatEngineRetriever<unknown> = {
      async search(_last, options) {
        seen = options;
        return null;
      },
    };
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'q' }],
      retriever,
      retrievalOptions: {
        documentIds: ['d1', 'd2'],
        collectionKeys: ['col-A'],
        sourceType: 'secondary',
        topK: 7,
      },
    });
    expect(seen).toEqual({
      documentIds: ['d1', 'd2'],
      collectionKeys: ['col-A'],
      sourceType: 'secondary',
      topK: 7,
    });
  });

  it('prepends systemPrompt.customText as the first system message', async () => {
    const captured: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'fake',
      name: 'Fake',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }) as never,
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* (msgs: ChatMessage[]) {
        captured.push(msgs);
        yield { delta: 'ok', done: false };
        yield { delta: '', done: true, finishReason: 'stop' };
      },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: { customText: 'CUSTOM PROMPT', modeId: 'explore' },
    });
    expect(captured[0][0]).toEqual({ role: 'system', content: 'CUSTOM PROMPT' });
    expect(captured[0][1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('ignores systemPrompt when customText is empty or whitespace', async () => {
    const captured: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'fake',
      name: 'Fake',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }) as never,
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* (msgs: ChatMessage[]) {
        captured.push(msgs);
        yield { delta: '', done: true, finishReason: 'stop' };
      },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'x' }],
      systemPrompt: { customText: '   ' },
    });
    expect(captured[0]).toHaveLength(1);
    expect(captured[0][0].role).toBe('user');
  });

  it('does not emit onExplanation when the retriever skips stats', async () => {
    const provider = makeFakeProvider([
      { delta: 'x', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ]);

    let calls = 0;
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'q' }],
      hooks: { onExplanation: () => { calls += 1; } },
    });
    expect(calls).toBe(0);
  });
});
