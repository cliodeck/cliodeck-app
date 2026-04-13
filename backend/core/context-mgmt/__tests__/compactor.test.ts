/**
 * Tests for `ContextCompactor` (fusion step 4.2).
 */

import { describe, expect, it } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  CompleteOptions,
  LLMProvider,
  ProviderStatus,
} from '../../llm/providers/base';
import {
  COMPACTED_SUMMARY_PREFIX,
  ContextCompactor,
  isCompactedSummary,
} from '../compactor';

/** Deterministic fake — never touches a network. */
class FakeLLM implements LLMProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly capabilities = {
    chat: true,
    streaming: false,
    tools: false,
    embeddings: false,
  };
  completeCalls: Array<{ prompt: string; opts?: CompleteOptions }> = [];
  summaryText = 'SUMMARY_OK';

  getStatus(): ProviderStatus {
    return { state: 'ready' };
  }
  async healthCheck(): Promise<ProviderStatus> {
    return { state: 'ready' };
  }
  // eslint-disable-next-line require-yield
  async *chat(
    _messages: ChatMessage[],
    _opts?: ChatOptions,
  ): AsyncIterable<ChatChunk> {
    throw new Error('chat() not used by ContextCompactor tests');
  }
  async complete(prompt: string, opts?: CompleteOptions): Promise<string> {
    this.completeCalls.push({ prompt, opts });
    return this.summaryText;
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
    expect(llm.completeCalls).toHaveLength(0);
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
    expect(llm.completeCalls).toHaveLength(1);

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
    expect(llm.completeCalls).toHaveLength(1);
    expect(llm.completeCalls[0].prompt).not.toContain('CITATION: Clavert');
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
    const callsAfterFirst = llm.completeCalls.length;
    expect(callsAfterFirst).toBe(1);

    const twice = await compactor.compact(once);
    // Under the threshold now → same reference, no extra LLM call.
    expect(twice).toBe(once);
    expect(llm.completeCalls.length).toBe(callsAfterFirst);
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
    expect(llm.completeCalls).toHaveLength(1);
  });
});
