/**
 * Context compaction (fusion step 4.2).
 *
 * Long brainstorm sessions eventually saturate a provider's context window.
 * `ContextCompactor` is a pure library: it takes a conversation and, when it
 * crosses a configurable fraction of the window (default 70%), compresses the
 * middle of the dialogue into a single LLM-generated summary while preserving
 * (a) all system messages, (b) the last N conversational turns verbatim, and
 * (c) messages tagged as RAG citations (`meta.ragCitation === true`) so that
 * bibliographic fidelity is never traded for brevity. Wiring into the
 * brainstorm chat loop happens in a later phase; this module is
 * framework-agnostic and exercised only through an injected `LLMProvider`.
 */

import type {
  ChatMessage,
  CompleteOptions,
  LLMProvider,
} from '../llm/providers/base';

export type TokenEstimator = (text: string) => number;

export interface ContextCompactorOptions {
  /** Provider used to produce the summary of the middle section. */
  llm: LLMProvider;
  /** Context window (in tokens) of the currently selected chat model. */
  contextWindow: number;
  /** Fraction of `contextWindow` at which compaction kicks in. Default 0.7. */
  threshold?: number;
  /**
   * Number of most-recent "turns" kept intact. A turn is a user message plus
   * any assistant / tool messages that follow it until the next user message.
   * Default: 4.
   */
  keepRecentTurns?: number;
  /** Rough token counter; default `Math.ceil(text.length / 4)`. Injectable for tests. */
  tokenEstimator?: TokenEstimator;
  /** Options forwarded to `llm.complete` when producing the summary. */
  summarizeOptions?: CompleteOptions;
}

/** Marker placed at the start of the summary message `content`. */
export const COMPACTED_SUMMARY_PREFIX = '[Compacted summary of';

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_KEEP_RECENT_TURNS = 4;

const defaultTokenEstimator: TokenEstimator = (text) =>
  Math.ceil((text ?? '').length / 4);

/** True if the message is a RAG citation and must be preserved verbatim. */
export function isRagCitation(m: ChatMessage): boolean {
  return m.meta?.ragCitation === true;
}

/** True if the message is a compacted-summary marker produced by this module. */
export function isCompactedSummary(m: ChatMessage): boolean {
  return m.role === 'system' && m.content.startsWith(COMPACTED_SUMMARY_PREFIX);
}

export class ContextCompactor {
  private readonly llm: LLMProvider;
  /** Context window in tokens — exposed so callers can populate
   *  telemetry / explanation payloads with the active value. */
  readonly contextWindow: number;
  private readonly threshold: number;
  private readonly keepRecentTurns: number;
  private readonly tokenEstimator: TokenEstimator;
  private readonly summarizeOptions: CompleteOptions;

  constructor(opts: ContextCompactorOptions) {
    if (opts.contextWindow <= 0) {
      throw new Error('ContextCompactor: contextWindow must be > 0');
    }
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    if (threshold <= 0 || threshold > 1) {
      throw new Error('ContextCompactor: threshold must be in (0, 1]');
    }
    const keepRecentTurns = opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
    if (keepRecentTurns < 0 || !Number.isInteger(keepRecentTurns)) {
      throw new Error('ContextCompactor: keepRecentTurns must be a non-negative integer');
    }
    this.llm = opts.llm;
    this.contextWindow = opts.contextWindow;
    this.threshold = threshold;
    this.keepRecentTurns = keepRecentTurns;
    this.tokenEstimator = opts.tokenEstimator ?? defaultTokenEstimator;
    this.summarizeOptions = opts.summarizeOptions ?? {};
  }

  /** Total estimated token count of `messages`. */
  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += this.tokenEstimator(m.content);
    }
    return total;
  }

  /** Returns the effective compaction trigger in tokens. */
  get triggerTokens(): number {
    return Math.floor(this.contextWindow * this.threshold);
  }

  /**
   * Compact a conversation. When total estimated tokens are under the
   * threshold, returns `messages` unchanged (same reference). Otherwise
   * returns a new array: system messages + summary (if any) + preserved
   * RAG citations + last N turns.
   */
  async compact(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const totalTokens = this.estimateTokens(messages);
    if (totalTokens <= this.triggerTokens) {
      return messages;
    }

    // Partition: system (kept), non-system (candidate for compaction).
    const systemMessages: ChatMessage[] = [];
    const nonSystem: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemMessages.push(m);
      } else {
        nonSystem.push(m);
      }
    }

    // Identify boundary of last N turns inside nonSystem.
    // A turn starts at a 'user' message. We walk from the end, counting turns
    // by the user messages encountered; everything from that user onward is
    // "recent" and kept verbatim.
    const recentStart = findRecentTurnsStart(nonSystem, this.keepRecentTurns);
    const middle = nonSystem.slice(0, recentStart);
    const recent = nonSystem.slice(recentStart);

    // If there is no middle to compact, nothing we can do beyond what we've
    // already tried; return messages unchanged to preserve idempotency.
    if (middle.length === 0) {
      return messages;
    }

    // Pull RAG citations out of the middle: they pass through untouched,
    // appended just before the recent turns so that the model still "sees"
    // them near the active context.
    const middleCitations = middle.filter(isRagCitation);
    const middleToSummarize = middle.filter((m) => !isRagCitation(m));

    // If the middle has nothing summarizable (only citations), nothing to do.
    if (middleToSummarize.length === 0) {
      return messages;
    }

    const summaryText = await this.summarize(middleToSummarize);
    const header = `${COMPACTED_SUMMARY_PREFIX} ${middleToSummarize.length} earlier turns] `;
    const summaryMessage: ChatMessage = {
      role: 'system',
      content: header + summaryText.trim(),
    };

    return [
      ...systemMessages,
      summaryMessage,
      ...middleCitations,
      ...recent,
    ];
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const transcript = messages
      .map((m) => {
        const who =
          m.role === 'user'
            ? 'User'
            : m.role === 'assistant'
              ? 'Assistant'
              : m.role === 'tool'
                ? `Tool(${m.name ?? 'unknown'})`
                : 'System';
        return `${who}: ${m.content}`;
      })
      .join('\n\n');

    const prompt =
      'You are compressing an earlier portion of a brainstorm conversation ' +
      'so the dialogue can continue within a smaller context window. ' +
      'Produce a faithful, third-person summary that preserves: key user ' +
      'questions, decisions reached, named entities, and any commitments ' +
      'the assistant made. Omit small talk and repeated reformulations. ' +
      'Do not invent facts. Output plain prose, no lists, no preamble.\n\n' +
      '--- CONVERSATION ---\n' +
      transcript +
      '\n--- END ---\n\nSummary:';

    return this.llm.complete(prompt, this.summarizeOptions);
  }
}

/**
 * Given a list of non-system messages and a target number of turns to keep,
 * return the index at which the "recent" slice starts. A turn is anchored on
 * a `user` message. If fewer than N user messages exist, everything is recent.
 */
function findRecentTurnsStart(nonSystem: ChatMessage[], keepRecentTurns: number): number {
  if (keepRecentTurns <= 0) return nonSystem.length;
  let turns = 0;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i].role === 'user') {
      turns++;
      if (turns === keepRecentTurns) {
        return i;
      }
    }
  }
  return 0;
}
