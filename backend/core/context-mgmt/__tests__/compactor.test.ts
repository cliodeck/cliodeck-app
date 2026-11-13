/**
 * Tests for `ContextCompactor` (fusion step 4.2).
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  CompleteOptions,
  LLMProvider,
  ProviderStatus,
} from '../../llm/providers/base';
import { collectCompletion } from '../../llm/providers/collect';
import {
  COMPACTED_SUMMARY_PREFIX,
  ContextCompactor,
  isCompactedSummary,
} from '../compactor';

/**
 * Deterministic fake — never touches a network. Son `complete()` est celui de tous les vrais
 * fournisseurs depuis L09-7 : le `chat()` ci-dessous, consommé par `collectCompletion`.
 */
class FakeLLM implements LLMProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly model = 'fake-model';
  readonly capabilities = {
    chat: true,
    streaming: false,
    tools: false,
    embeddings: false,
  };
  chatCalls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  summaryText = 'SUMMARY_OK';
  /** Le flux du résumé ; absent, `summaryText` en un seul delta, puis `stop`. */
  stream?: (opts?: ChatOptions) => AsyncIterable<ChatChunk>;
  status: ProviderStatus = { state: 'ready' };

  /** Le prompt de chaque résumé demandé. */
  get prompts(): string[] {
    return this.chatCalls.map((c) => c.messages.map((m) => m.content).join('\n'));
  }

  getStatus(): ProviderStatus {
    return this.status;
  }
  async healthCheck(): Promise<ProviderStatus> {
    return { state: 'ready' };
  }
  async *chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk> {
    this.chatCalls.push({ messages, opts });
    if (this.stream) {
      yield* this.stream(opts);
      return;
    }
    yield { delta: this.summaryText };
    yield { delta: '', done: true, finishReason: 'stop' };
  }
  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    const { text } = await collectCompletion(this, this.chat([{ role: 'user', content: prompt }], opts));
    return text;
  }
  async dispose(): Promise<void> {
    // no-op
  }
}

/** Build a turn (1 user + 1 assistant). */
function turn(i: number, contentLen = 400): ChatMessage[] {
  return [
    { role: 'user', content: `U${i}:${'x'.repeat(contentLen)}` },
    { role: 'assistant', content: `A${i}:${'y'.repeat(contentLen)}` },
  ];
}

describe('ContextCompactor', () => {
  it('returns input unchanged when below threshold', async () => {
    const llm = new FakeLLM();
    const compactor = new ContextCompactor({
      llm,
      contextWindow: 10_000,
      threshold: 0.7,
      keepRecentTurns: 2,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be helpful.' },
      ...turn(1, 40),
      ...turn(2, 40),
    ];
    const out = await compactor.compact(messages);
    expect(out).toBe(messages);
    expect(llm.chatCalls).toHaveLength(0);
  });

  it('compacts the middle and preserves system + last N turns', async () => {
    const llm = new FakeLLM();
    llm.summaryText = 'The user and assistant discussed prior turns.';

    // 10 turns, each ~800 chars ≈ 200 tokens. Window 1000 × 0.7 = 700.
    const systemMsg: ChatMessage = { role: 'system', content: 'sys-prompt' };
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 10; i++) turns.push(...turn(i, 400));
    const messages: ChatMessage[] = [systemMsg, ...turns];

    const compactor = new ContextCompactor({
      llm,
      contextWindow: 1000,
      threshold: 0.7,
      keepRecentTurns: 3,
    });
    const out = await compactor.compact(messages);

    expect(out).not.toBe(messages);
    expect(llm.chatCalls).toHaveLength(1);

    // Structure: [system, summary, ...last3 turns as user/assistant]
    expect(out[0]).toEqual(systemMsg);
    expect(isCompactedSummary(out[1])).toBe(true);
    expect(out[1].content.startsWith(COMPACTED_SUMMARY_PREFIX)).toBe(true);
    expect(out[1].content).toContain('SUMMARY_OK'.slice(0, 0)); // trivially true
    expect(out[1].content).toContain('The user and assistant discussed');

    // Last 3 turns preserved verbatim (turns 8, 9, 10 → 6 messages).
    const tail = out.slice(2);
    expect(tail).toHaveLength(6);
    expect(tail[0]).toMatchObject({ role: 'user', content: expect.stringMatching(/^U8:/) });
    expect(tail[5]).toMatchObject({ role: 'assistant', content: expect.stringMatching(/^A10:/) });
  });

  it('preserves RAG citation messages verbatim (not summarized)', async () => {
    const llm = new FakeLLM();

    const systemMsg: ChatMessage = { role: 'system', content: 'sys' };
    const citation: ChatMessage = {
      role: 'assistant',
      content: 'CITATION: Clavert, 2022, p.42',
      meta: { ragCitation: true, sourceId: 'src-1', chunkId: 'c-7' },
    };
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 8; i++) turns.push(...turn(i, 400));
    const messages: ChatMessage[] = [
      systemMsg,
      ...turns.slice(0, 4),
      citation,
      ...turns.slice(4),
    ];

    const compactor = new ContextCompactor({
      llm,
      contextWindow: 1000,
      threshold: 0.7,
      keepRecentTurns: 2,
    });
    const out = await compactor.compact(messages);

    // Citation must still be present, verbatim, with its meta intact.
    const preserved = out.find(
      (m) => m.content === 'CITATION: Clavert, 2022, p.42',
    );
    expect(preserved).toBeDefined();
    expect(preserved?.meta?.ragCitation).toBe(true);
    expect(preserved?.meta?.sourceId).toBe('src-1');

    // Summarizer prompt should NOT contain the citation text.
    expect(llm.chatCalls).toHaveLength(1);
    expect(llm.prompts[0]).not.toContain('CITATION: Clavert');
  });

  it('is idempotent: compacting an already-compacted output is a no-op', async () => {
    const llm = new FakeLLM();
    llm.summaryText = 'short summary';

    const systemMsg: ChatMessage = { role: 'system', content: 'sys' };
    const turns: ChatMessage[] = [];
    for (let i = 1; i <= 10; i++) turns.push(...turn(i, 400));
    const messages: ChatMessage[] = [systemMsg, ...turns];

    const compactor = new ContextCompactor({
      llm,
      contextWindow: 1000,
      threshold: 0.7,
      keepRecentTurns: 3,
    });

    const once = await compactor.compact(messages);
    const callsAfterFirst = llm.chatCalls.length;
    expect(callsAfterFirst).toBe(1);

    const twice = await compactor.compact(once);
    // Under the threshold now → same reference, no extra LLM call.
    expect(twice).toBe(once);
    expect(llm.chatCalls.length).toBe(callsAfterFirst);
  });

  it('rejects invalid options', () => {
    const llm = new FakeLLM();
    expect(
      () => new ContextCompactor({ llm, contextWindow: 0 }),
    ).toThrow(/contextWindow/);
    expect(
      () => new ContextCompactor({ llm, contextWindow: 1000, threshold: 0 }),
    ).toThrow(/threshold/);
    expect(
      () =>
        new ContextCompactor({
          llm,
          contextWindow: 1000,
          keepRecentTurns: -1,
        }),
    ).toThrow(/keepRecentTurns/);
  });

  it('honors a custom tokenEstimator', async () => {
    const llm = new FakeLLM();
    // Every message counts as 1000 tokens → threshold crossed immediately.
    const compactor = new ContextCompactor({
      llm,
      contextWindow: 1000,
      threshold: 0.7,
      keepRecentTurns: 1,
      tokenEstimator: () => 1000,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      ...turn(1, 4),
      ...turn(2, 4),
      ...turn(3, 4),
    ];
    const out = await compactor.compact(messages);
    expect(out).not.toBe(messages);
    expect(llm.chatCalls).toHaveLength(1);
  });
});

/**
 * Le résumé appartient au tour (S05-1-8, S06-1-18). Un résumé vide remplaçait en silence tout le
 * milieu de la conversation : le modèle répondait sans les échanges antérieurs, et rien ne le
 * disait. Et l'appel de résumé partait détaché du tour : sans son signal (« Arrêter » ne l'arrêtait
 * pas), sans signe de vie pour le délai d'inactivité.
 */
describe('ContextCompactor — le résumé appartient au tour', () => {
  /** 10 tours d'environ 200 jetons contre un seuil de 700 : le milieu se résume. */
  function longConversation(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 1; i <= 10; i++) messages.push(...turn(i, 400));
    return messages;
  }
  const makeCompactor = (llm: FakeLLM, summarizeOptions?: CompleteOptions): ContextCompactor =>
    new ContextCompactor({ llm, contextWindow: 1000, threshold: 0.7, keepRecentTurns: 3, summarizeOptions });

  it('un résumé vide (fin normale, aucun texte) ne remplace rien : même référence rendue', async () => {
    const llm = new FakeLLM();
    llm.summaryText = '  \n ';
    const messages = longConversation();
    const out = await makeCompactor(llm).compact(messages);
    expect(llm.chatCalls).toHaveLength(1);
    expect(out).toBe(messages);
    expect(out.some(isCompactedSummary)).toBe(false);
  });

  it('témoin L09-7 : un flux terminé en error ne donne pas de résumé vide, compact lève avec la cause', async () => {
    const llm = new FakeLLM();
    llm.status = {
      state: 'degraded',
      lastError: { code: 'ollama_http_500', message: 'model requires more system memory', at: 'now' },
    };
    llm.stream = async function* () {
      yield { delta: '', done: true, finishReason: 'error' };
    };
    const messages = longConversation();
    const before = [...messages];
    await expect(makeCompactor(llm).compact(messages)).rejects.toMatchObject({
      name: 'ProviderCallError',
      code: 'ollama_http_500',
    });
    expect(messages).toEqual(before);
  });

  it('numCtx, think:false et le signal du tour atteignent l’appel au fournisseur', async () => {
    const llm = new FakeLLM();
    const controller = new AbortController();
    await makeCompactor(llm, { temperature: 0, numCtx: 32_768, think: false }).compact(
      longConversation(),
      { signal: controller.signal }
    );
    expect(llm.chatCalls).toHaveLength(1);
    expect(llm.chatCalls[0].opts).toMatchObject({ temperature: 0, numCtx: 32_768, think: false });
    expect(llm.chatCalls[0].opts?.signal).toBe(controller.signal);
  });

  it('abandonné pendant le résumé : compact lève en cancelled, et rien n’est remplacé', async () => {
    const llm = new FakeLLM();
    const controller = new AbortController();
    let summarizing = false;
    llm.stream = async function* (opts) {
      const signal = opts?.signal;
      // Sans signal, rien n'arrête le résumé : c'est le défaut.
      if (!signal) throw new Error('aucun signal transmis au résumé');
      summarizing = true;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { delta: '', done: true, finishReason: 'cancelled' };
    };
    const compacting = makeCompactor(llm).compact(longConversation(), { signal: controller.signal });
    await vi.waitFor(() => expect(summarizing).toBe(true));
    controller.abort();
    await expect(compacting).rejects.toMatchObject({ name: 'ProviderCallError', finishReason: 'cancelled' });
  });

  it('onActivity à chaque chunk du résumé, raisonnement compris', async () => {
    const llm = new FakeLLM();
    llm.stream = async function* () {
      yield { delta: '', thinking: 'Je relis les échanges.' };
      yield { delta: 'Ils ont parlé ' };
      yield { delta: 'du préfet Chiappe.' };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    let activity = 0;
    const out = await makeCompactor(llm).compact(longConversation(), {
      onActivity: () => {
        activity += 1;
      },
    });
    expect(activity).toBe(4);
    expect(out[1].content).toContain('Ils ont parlé du préfet Chiappe.');
    expect(out[1].content).not.toContain('Je relis');
  });

  it('needsCompaction suit la décision de compact : sous le seuil ou rien à résumer, non', () => {
    const llm = new FakeLLM();
    const compactor = makeCompactor(llm);
    expect(compactor.needsCompaction([{ role: 'system', content: 'sys' }, ...turn(1, 40)])).toBe(false);
    expect(compactor.needsCompaction(longConversation())).toBe(true);
    // Au-dessus du seuil, mais tout tient dans les derniers tours gardés tels quels : aucun résumé.
    const recentOnly: ChatMessage[] = [{ role: 'system', content: 'x'.repeat(4000) }, ...turn(1, 40)];
    expect(compactor.needsCompaction(recentOnly)).toBe(false);
    expect(llm.chatCalls).toHaveLength(0);
  });
});
