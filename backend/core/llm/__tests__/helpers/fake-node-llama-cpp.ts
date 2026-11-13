/**
 * Double de `node-llama-cpp` pour les tests de la génération embarquée : aucun GGUF n'est chargé.
 *
 * À brancher par `vi.mock('node-llama-cpp', async () => (await import('…/fake-node-llama-cpp.js')).fakeNodeLlamaCpp)`
 * et à remettre à zéro par `fakeLlama.reset()` avant chaque test.
 *
 * Un jeton vaut un mot, blanc compris : `detokenize(tokenize(t)) === t`. Le moteur se comporte
 * comme le vrai devant un contexte trop petit pour ce qu'on lui donne :
 * - la première consigne système ne se coupe jamais : consignes et question qui dépassent la
 *   fenêtre (moins la marge de décalage, un dixième) lèvent « Failed to compress chat history » ;
 * - un texte de l'utilisateur trop long, lui, est coupé, et c'est sa fin qui part (mesuré sur le
 *   vrai moteur : « La question semble être incomplète »).
 */

export type FakeChatItem =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: string[] };

export interface FakePromptOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  onTextChunk?: (chunk: string) => void;
}

export interface FakeSession {
  /** `systemPrompt` passé au constructeur. */
  systemPrompt: string | undefined;
  /** Dernier `setChatHistory`, ou `null` s'il n'a pas été appelé. */
  history: FakeChatItem[] | null;
  /** Chaque appel à `prompt`, avec le texte que le moteur a réellement gardé. */
  prompts: Array<{ text: string; kept: string; options: FakePromptOptions }>;
  /** Arguments de `dispose`, `undefined` tant que la session vit. */
  disposed: { disposeSequence?: boolean } | undefined;
}

export const FAILED_TO_COMPRESS =
  'Failed to compress chat history for context shift due to a too long prompt or system message that cannot be compressed without affecting the generation quality. ' +
  'Consider increasing the context size or shortening the long prompt or system message.';

export const fakeLlama = {
  /** `contextSize` de chaque contexte créé. */
  contextSizes: [] as number[],
  sessions: [] as FakeSession[],
  /** Morceaux rendus par `onTextChunk`, dans l'ordre. */
  reply: ['Selon [1], ', 'la grève éclate en 1910.'] as string[],
  /** Appels à `sequence.clearHistory()`. */
  cleared: 0,
  /** Modèles libérés. */
  modelsDisposed: 0,
  reset(): void {
    this.contextSizes = [];
    this.sessions = [];
    this.reply = ['Selon [1], ', 'la grève éclate en 1910.'];
    this.cleared = 0;
    this.modelsDisposed = 0;
  },
};

/** Un jeton par mot, avec le blanc qui le suit. */
export function fakeTokenize(text: string): string[] {
  return text.match(/\s*\S+\s*/g) ?? (text ? [text] : []);
}

function fakeDetokenize(tokens: readonly unknown[]): string {
  return tokens.map(String).join('');
}

interface FakeSequence {
  contextSize: number;
  clearHistory(): Promise<void>;
}

class LlamaChatSession {
  private readonly record: FakeSession;
  private readonly sequence: FakeSequence;

  constructor(options: { contextSequence: FakeSequence; systemPrompt?: string }) {
    this.sequence = options.contextSequence;
    this.record = { systemPrompt: options.systemPrompt, history: null, prompts: [], disposed: undefined };
    fakeLlama.sessions.push(this.record);
  }

  setChatHistory(history: FakeChatItem[]): void {
    this.record.history = structuredClone(history);
  }

  async prompt(text: string, options: FakePromptOptions = {}): Promise<string> {
    const limit = this.sequence.contextSize - Math.floor(this.sequence.contextSize / 10);
    const first = this.record.history?.[0];
    const systemTokens = first?.type === 'system' ? fakeTokenize(first.text).length : 0;
    const promptTokens = fakeTokenize(text);
    if (systemTokens + promptTokens.length > limit) {
      if (systemTokens > 0) throw new Error(FAILED_TO_COMPRESS);
      // Sans consigne système, le moteur coupe le texte de l'utilisateur, par la fin.
      const kept = promptTokens.slice(0, limit).join('');
      this.record.prompts.push({ text, kept, options });
    } else {
      this.record.prompts.push({ text, kept: text, options });
    }
    for (const chunk of fakeLlama.reply) options.onTextChunk?.(chunk);
    return fakeLlama.reply.join('');
  }

  dispose(options: { disposeSequence?: boolean } = {}): void {
    this.record.disposed = options;
  }
}

async function loadModel(): Promise<unknown> {
  return {
    tokenize: fakeTokenize,
    detokenize: fakeDetokenize,
    async createContext({ contextSize = 4096 }: { contextSize?: number }) {
      fakeLlama.contextSizes.push(contextSize);
      const sequence: FakeSequence = {
        contextSize,
        async clearHistory() {
          fakeLlama.cleared += 1;
        },
      };
      return { getSequence: () => sequence, dispose: async () => undefined };
    },
    async dispose() {
      fakeLlama.modelsDisposed += 1;
    },
  };
}

export const fakeNodeLlamaCpp = {
  getLlama: async () => ({ loadModel }),
  LlamaChatSession,
};
