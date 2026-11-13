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
 *
 * La génération court comme la vraie (L09-10) : un morceau par tour de boucle d'événements, rendu
 * par `onTextChunk` pendant que la promesse de `prompt` n'est pas encore réglée. Le signal est lu
 * comme le lit node-llama-cpp 3.18.1 (`withLock`, `ensureNotAborted`, `handleAbortTrigger`) :
 * - déjà avorté à l'appel, `prompt` lève sa raison avant tout ;
 * - avorté avant le premier morceau, `prompt` lève sa raison, même avec `stopOnAbortSignal` ;
 * - avorté ensuite, avec `stopOnAbortSignal`, la génération s'arrête au morceau suivant et `prompt`
 *   rend le texte déjà produit ; sans l'option, elle lève la raison ;
 * - sans signal, rien ne l'arrête : elle va au bout de `reply`.
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
  stopOnAbortSignal?: boolean;
  onTextChunk?: (chunk: string) => void;
}

/** Un appel à `prompt`, tel que le moteur l'a vu et mené. */
export interface FakePrompt {
  text: string;
  /** Le texte que le moteur a réellement gardé. */
  kept: string;
  options: FakePromptOptions;
  /** Morceaux rendus par `onTextChunk` jusqu'ici. */
  emitted: number;
  /** La promesse de `prompt` est réglée : la génération est finie, arrêtée ou tombée. */
  settled: boolean;
}

export interface FakeSession {
  /** `systemPrompt` passé au constructeur. */
  systemPrompt: string | undefined;
  /** Dernier `setChatHistory`, ou `null` s'il n'a pas été appelé. */
  history: FakeChatItem[] | null;
  /** Chaque appel à `prompt`. */
  prompts: FakePrompt[];
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
  /** Message de l'exception que lève `prompt`, pour simuler une panne du moteur. */
  failWith: undefined as string | undefined,
  /** Attentes de `whenEmitted`, servies au fil de la génération. */
  waiters: [] as Array<{ count: number; resolve: () => void }>,
  reset(): void {
    this.contextSizes = [];
    this.sessions = [];
    this.reply = ['Selon [1], ', 'la grève éclate en 1910.'];
    this.cleared = 0;
    this.modelsDisposed = 0;
    this.failWith = undefined;
    this.waiters = [];
  },
  /**
   * Résolue quand la génération a rendu `count` morceaux (`0` : dès que `prompt` démarre), à demander
   * avant de la lancer. Elle se résout avant que le moteur ne produise le suivant : un `abort()` posé
   * aussitôt tombe entre deux morceaux, comme « Arrêter » pendant que le modèle écrit.
   */
  whenEmitted(count: number): Promise<void> {
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  },
  /** Sert les attentes atteintes. */
  reached(emitted: number): void {
    const due = this.waiters.filter((w) => w.count <= emitted);
    this.waiters = this.waiters.filter((w) => w.count > emitted);
    for (const w of due) w.resolve();
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
    const { signal } = options;
    // `withLock` : un signal déjà avorté lève sa raison avant toute évaluation.
    if (signal?.aborted) throw signal.reason;
    if (fakeLlama.failWith) throw new Error(fakeLlama.failWith);
    const limit = this.sequence.contextSize - Math.floor(this.sequence.contextSize / 10);
    const first = this.record.history?.[0];
    const systemTokens = first?.type === 'system' ? fakeTokenize(first.text).length : 0;
    const promptTokens = fakeTokenize(text);
    let kept = text;
    if (systemTokens + promptTokens.length > limit) {
      if (systemTokens > 0) throw new Error(FAILED_TO_COMPRESS);
      // Sans consigne système, le moteur coupe le texte de l'utilisateur, par la fin.
      kept = promptTokens.slice(0, limit).join('');
    }
    const call: FakePrompt = { text, kept, options, emitted: 0, settled: false };
    this.record.prompts.push(call);
    fakeLlama.reached(0);
    try {
      const produced: string[] = [];
      for (const chunk of fakeLlama.reply) {
        // Un jeton par tour de boucle d'événements : la promesse court pendant que les morceaux partent.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
          if (options.stopOnAbortSignal && produced.length > 0) return produced.join('');
          throw signal.reason;
        }
        produced.push(chunk);
        call.emitted += 1;
        options.onTextChunk?.(chunk);
        fakeLlama.reached(call.emitted);
      }
      return produced.join('');
    } finally {
      call.settled = true;
    }
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
