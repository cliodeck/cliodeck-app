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

describe('chat-engine compactor wiring (1.3)', () => {
  it('runs the compactor before provider.chat and uses the compacted messages', async () => {
    const captured: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'fake',
      name: 'Fake',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }) as never,
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* (msgs: ChatMessage[]) {
        // Snapshot the array the engine handed us — the test asserts on it.
        captured.push(msgs.slice());
        yield { delta: 'ok', done: false };
        yield { delta: '', done: true, finishReason: 'stop' };
      },
      complete: async () => 'SUMMARY',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    // Stub compactor that always shortens the conversation to a single
    // system + the last user turn. The engine doesn't introspect the
    // compactor — it just calls .compact() — so a duck-typed shape works.
    const stubCompactor = {
      contextWindow: 8192,
      compact: async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        return [
          { role: 'system', content: '[Compacted] earlier turns omitted' },
          ...(lastUser ? [lastUser] : []),
        ];
      },
    } as unknown as Parameters<typeof runChatTurn>[0]['compactor'];

    const status: string[] = [];
    await runChatTurn({
      provider,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'second reply' },
        { role: 'user', content: 'third' },
      ],
      compactor: stubCompactor,
      hooks: {
        onStatus: (s) => {
          status.push(s.phase);
        },
      },
    });

    // The engine should have routed the COMPACTED messages — not the
    // original 5 — to the provider.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(2);
    expect(captured[0][0].role).toBe('system');
    expect(captured[0][0].content).toContain('Compacted');
    expect(captured[0][1]).toEqual({ role: 'user', content: 'third' });

    // The 'compressing' status banner fires whenever the compactor
    // returns a different array reference (i.e. actual compaction).
    expect(status).toContain('compressing');
  });

  it('skips compaction silently when the compactor returns the same array', async () => {
    const provider = makeFakeProvider([
      { delta: '', done: true, finishReason: 'stop' },
    ]);

    let compactCalls = 0;
    const noopCompactor = {
      contextWindow: 8192,
      compact: async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
        compactCalls++;
        return messages; // unchanged → no 'compressing' status
      },
    } as unknown as Parameters<typeof runChatTurn>[0]['compactor'];

    const status: string[] = [];
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'short' }],
      compactor: noopCompactor,
      hooks: {
        onStatus: (s) => {
          status.push(s.phase);
        },
      },
    });

    expect(compactCalls).toBe(1);
    // Only retrieval-skip + done; compressing never fired.
    expect(status).not.toContain('compressing');
  });

  it('swallows compactor errors and proceeds with the original messages', async () => {
    const captured: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'fake',
      name: 'Fake',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }) as never,
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* (msgs: ChatMessage[]) {
        captured.push(msgs.slice());
        yield { delta: '', done: true, finishReason: 'stop' };
      },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    const failingCompactor = {
      contextWindow: 8192,
      compact: async () => {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof runChatTurn>[0]['compactor'];

    await runChatTurn({
      provider,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
      compactor: failingCompactor,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(2);
  });
});
