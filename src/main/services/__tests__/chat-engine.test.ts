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
