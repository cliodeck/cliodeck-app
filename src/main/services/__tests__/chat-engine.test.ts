import { describe, it, expect, vi } from 'vitest';
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
  it('tells the model and UI when retrieval throws', async () => {
    const seen: ChatMessage[][] = [];
    const provider = makeFakeProvider([]);
    provider.chat = async function* (messages: ChatMessage[]) {
      seen.push(messages);
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    let explanation: RAGExplanation | undefined;
    await runChatTurn({
      provider, messages: [{ role: 'user', content: 'q' }],
      retriever: { search: async () => { throw new Error('offline'); } },
      hooks: { onExplanation: (value) => { explanation = value; } },
    });
    expect(seen[0][0].content).toContain('source search failed');
    expect(explanation?.search.retrievalStatus).toBe('failed');
  });

  it('dit l’échec de la recherche dans la langue des consignes (#212)', async () => {
    const consigne = async (promptLanguage: 'fr' | 'en'): Promise<string> => {
      const seen: ChatMessage[][] = [];
      const provider = makeFakeProvider([]);
      provider.chat = async function* (messages: ChatMessage[]) {
        seen.push(messages);
        yield { delta: '', done: true, finishReason: 'stop' };
      };
      await runChatTurn({
        provider, messages: [{ role: 'user', content: 'q' }], promptLanguage,
        retriever: { search: async () => { throw new Error('offline'); } },
      });
      return seen[0][0].content;
    };
    const fr = await consigne('fr');
    expect(fr).toContain('La recherche dans les sources a échoué');
    expect(fr).not.toContain('source search failed');
    expect(await consigne('en')).toContain('The source search failed');
  });

  it('forwards an empty retrieval result and its explanation to the model and UI', async () => {
    const seen: ChatMessage[][] = [];
    const provider = makeFakeProvider([{ delta: '', done: true, finishReason: 'stop' }]);
    provider.chat = async function* (messages: ChatMessage[]) {
      seen.push(messages);
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    let explanation: RAGExplanation | undefined;
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'q' }],
      retriever: { search: async () => ({
        systemPrompt: 'No evidence found', sources: [],
        explanation: { search: { query: 'q', totalResults: 0, searchDurationMs: 1,
          cacheHit: false, sourceType: 'both', documents: [] } },
      }) },
      hooks: { onExplanation: (value) => { explanation = value; } },
    });
    expect(seen[0].map((message) => message.content)).toContain('No evidence found');
    expect(explanation?.search.totalResults).toBe(0);
  });

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

  it('insère le bloc de contexte après les messages système de tête, avant la conversation', async () => {
    // Jusqu'en 2026-10 le bloc de contexte était mis DEVANT le prompt de
    // mode : le modèle lisait les extraits avant de connaître son rôle, et
    // le manuscrit était la dernière matière lue (docs/poids-du-manuscrit.md).
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
    const retriever: ChatEngineRetriever<{ title: string }> = {
      async search() {
        return { systemPrompt: 'CTX', sources: [{ title: 'doc A' }] };
      },
    };

    await runChatTurn<{ title: string }>({
      provider,
      // Les consignes de projet (`hints.md`) arrivent déjà en tête, en `system`.
      messages: [
        { role: 'system', content: 'HINTS' },
        { role: 'user', content: 'hello' },
      ],
      retriever,
      systemPrompt: { customText: 'MODE PROMPT' },
    });
    expect(captured[0].map((m) => m.content)).toEqual(['MODE PROMPT', 'HINTS', 'CTX', 'hello']);
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

describe('chat-engine — options d’échantillonnage transmises au fournisseur', () => {
  it('transmet temperature, topP, topK, repeatPenalty et numCtx à provider.chat', async () => {
    let seenOpts: Record<string, unknown> | undefined;
    const provider = {
      id: 'fake',
      name: 'Fake',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'ready' }) as never,
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* (_: ChatMessage[], opts?: Record<string, unknown>) {
        seenOpts = opts;
        yield { delta: '', done: true, finishReason: 'stop' };
      },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      opts: { temperature: 0.1, topP: 0.85, topK: 40, repeatPenalty: 1.1, numCtx: 1_048_576 },
    });

    expect(seenOpts).toMatchObject({
      temperature: 0.1,
      topP: 0.85,
      topK: 40,
      repeatPenalty: 1.1,
      numCtx: 1_048_576,
    });
  });
});

describe('chat-engine — un chunk terminal en erreur porte la cause du fournisseur', () => {
  it('appelle onError avec le lastError du statut, puis onDone en erreur', async () => {
    const provider = {
      id: 'ollama',
      name: 'Ollama',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({
        state: 'degraded',
        lastError: { code: 'ollama_http_500', message: 'model requires more system memory', at: 'now' },
      }),
      healthCheck: async () => ({ state: 'ready' }) as never,
      chat: async function* () {
        yield { delta: '', done: true, finishReason: 'error' };
      },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;

    const errors: Array<{ code: string; message: string }> = [];
    const dones: string[] = [];
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      hooks: {
        onError: (e) => errors.push(e),
        onDone: (c) => dones.push(c.finishReason ?? ''),
      },
    });
    expect(errors).toEqual([{ code: 'ollama_http_500', message: 'model requires more system memory' }]);
    expect(dones).toEqual(['error']);
  });

  it('donne une cause par défaut quand le fournisseur n’en a pas', async () => {
    const provider = makeFakeProvider([{ delta: '', done: true, finishReason: 'error' }]);
    const errors: Array<{ code: string; message: string }> = [];
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      hooks: { onError: (e) => errors.push(e) },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('provider_error');
  });
});

describe('chat-engine — raisonnement d’un modèle pensant', () => {
  it('relaie les chunks thinking, passe par la phase thinking puis generating', async () => {
    const provider = makeFakeProvider([
      { delta: '', thinking: 'hmm' },
      { delta: '', thinking: ' hmm' },
      { delta: 'Réponse', done: false },
      { delta: '', done: true, finishReason: 'stop' },
    ] as ChatChunk[]);
    const phases: string[] = [];
    const seen: ChatChunk[] = [];
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'ping' }],
      opts: { think: true },
      hooks: {
        onStatus: (s) => phases.push(s.phase),
        onChunk: (c) => seen.push(c),
      },
    });
    expect(seen.filter((c) => c.thinking).map((c) => c.thinking)).toEqual(['hmm', ' hmm']);
    expect(seen.filter((c) => c.delta).map((c) => c.delta)).toEqual(['Réponse']);
    expect(phases.indexOf('thinking')).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf('thinking')).toBeLessThan(phases.indexOf('generating'));
  });
});

/**
 * Un tour resté sans réponse laisse un message assistant vide dans l'historique (S06-1-1). Claude
 * refuse tout message non final au contenu vide, Gemini une part de texte vide : HTTP 400 à chaque
 * tour suivant. Le renderer ne l'envoie plus, et le moteur le retire pour tout autre appelant.
 */
describe('chat-engine — un tour sans réponse ne repart pas au fournisseur', () => {
  function recordingProvider(seen: ChatMessage[][]): LLMProvider {
    const provider = makeFakeProvider([]);
    provider.chat = async function* (messages: ChatMessage[]) {
      seen.push(messages);
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    return provider;
  }

  it('[user, assistant vide, user] arrive au fournisseur comme [user, user]', async () => {
    const seen: ChatMessage[][] = [];
    await runChatTurn({
      provider: recordingProvider(seen),
      messages: [
        { role: 'user', content: 'Qui était le préfet en 1934 ?' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Et en 1936 ?' },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { role: 'user', content: 'Qui était le préfet en 1934 ?' },
      { role: 'user', content: 'Et en 1936 ?' },
    ]);
  });

  it('un assistant fait d’espaces seuls est retiré lui aussi', async () => {
    const seen: ChatMessage[][] = [];
    await runChatTurn({
      provider: recordingProvider(seen),
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: ' \n ' },
        { role: 'user', content: 'q2' },
      ],
    });
    expect(seen[0].map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('ne touche ni system, ni tool, ni un assistant porteur de toolCalls au contenu vide', async () => {
    const seen: ChatMessage[][] = [];
    const history: ChatMessage[] = [
      { role: 'system', content: '' },
      { role: 'user', content: 'Cherche Chiappe.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '' },
      { role: 'assistant', content: 'Trouvé.' },
      { role: 'user', content: 'Merci.' },
    ];
    await runChatTurn({ provider: recordingProvider(seen), messages: history });
    expect(seen[0]).toEqual(history);
  });

  it('le message assistant de tool-call à contenu vide reste présent au second passage de la boucle', async () => {
    const seen: ChatMessage[][] = [];
    const provider = makeFakeProvider([]);
    provider.chat = async function* (messages: ChatMessage[]) {
      seen.push(messages);
      if (seen.length === 1) {
        yield { delta: '', toolCall: { id: 'c1', name: 'search', arguments: '{"q":"Chiappe"}' } };
        yield { delta: '', done: true, finishReason: 'tool_call' };
        return;
      }
      yield { delta: 'Trouvé.' };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'Cherche Chiappe.' }],
      tools: [{ name: 'search', description: 'cherche', parameters: { type: 'object' } }],
      toolHandler: { call: async () => ({ ok: true, result: { hits: 1 } }) },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([
      { role: 'user', content: 'Cherche Chiappe.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"Chiappe"}' }],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"hits":1}' },
    ]);
  });
});

/**
 * « Arrêter » pendant la recherche (J9). Le tour avait un signal (L08-3), mais la recherche ne le
 * recevait pas : l'embedding de la question, sans réponse (Ollama qui charge un modèle), retenait le
 * tour jusqu'au redémarrage, sa requête ouverte. Arrêté pendant la recherche, le tour finit annulé :
 * pas de consigne « la recherche a échoué », pas de panneau en échec, pas d'appel au modèle.
 */
describe('chat-engine — « Arrêter » pendant la recherche (J9)', () => {
  it('le signal du tour atteint la recherche ; arrêté, le tour finit annulé, sans échec ni appel au modèle', async () => {
    const controller = new AbortController();
    let searching = false;
    let seenSignal: AbortSignal | undefined;
    // Sans signal, la recherche n'a pas de fin : elle se libère à la fin du test.
    let release = (): void => undefined;
    const retriever: ChatEngineRetriever<unknown> = {
      search: (_lastUser, _options, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          searching = true;
          seenSignal = signal;
          release = () => reject(new Error('recherche jamais arrêtée'));
          // Comme la recherche réelle : elle rejette par la raison du signal.
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    };
    let providerCalls = 0;
    const provider = makeFakeProvider([]);
    provider.chat = async function* () {
      providerCalls += 1;
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    const done: ChatChunk[] = [];
    const errors: Array<{ code: string; message: string }> = [];
    const explanations: RAGExplanation[] = [];

    const turn = runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'Qui était le préfet en 1934 ?' }],
      signal: controller.signal,
      retriever,
      hooks: {
        onDone: (chunk) => done.push(chunk),
        onError: (err) => errors.push(err),
        onExplanation: (value) => explanations.push(value),
      },
    });
    await vi.waitFor(() => expect(searching).toBe(true));
    controller.abort();
    try {
      await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true), { timeout: 1_000 });
    } finally {
      release();
    }
    await turn;

    expect(done).toEqual([{ delta: '', done: true, finishReason: 'cancelled' }]);
    expect(errors).toEqual([]);
    expect(explanations.map((e) => e.search.retrievalStatus)).not.toContain('failed');
    expect(providerCalls).toBe(0);
  });
});
