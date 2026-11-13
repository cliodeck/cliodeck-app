/**
 * Client LLM embarqué utilisant node-llama-cpp
 * Modèle par défaut: Qwen2.5-0.5B-Instruct (~491 Mo)
 *
 * Supporte la génération de texte ET les embeddings via des modèles GGUF séparés.
 */

import { EMBEDDED_CONTEXT_SIZE, embeddedInputBudget, embeddedReplyTokens } from './context-windows.js';
import { forgetEmbeddedClient, isEmbeddedEngineClosing, trackEmbeddedClient } from './embedded-engine-pool.js';

// Types pour node-llama-cpp (évite les problèmes d'import ESM)
interface LlamaInstance {
  loadModel: (options: { modelPath: string }) => Promise<LlamaModelInstance>;
}

interface LlamaModelInstance {
  createContext: (options: {
    contextSize?: number;
    batchSize?: number;
  }) => Promise<LlamaContextInstance>;
  createEmbeddingContext: () => Promise<LlamaEmbeddingContextInstance>;
  embeddingVectorSize?: number;
  /** Fenêtre du modèle, en jetons (512 pour Nomic Embed v2). */
  trainContextSize?: number;
  tokenize?: (text: string) => ArrayLike<unknown>;
  /** L'inverse de `tokenize` : sert à couper des consignes au jeton près. */
  detokenize?: (tokens: readonly unknown[]) => string;
  /** Libère le GGUF chargé ; idempotent. Jamais `llama.dispose()`, qui libère le backend du processus. */
  dispose: () => Promise<void>;
}

interface LlamaContextInstance {
  getSequence: () => any;
  dispose: () => Promise<void>;
}

interface LlamaEmbeddingContextInstance {
  getEmbeddingFor: (text: string) => Promise<{ vector: number[] }>;
  dispose: () => Promise<void>;
}

/** Un tour de l'historique, tel que l'attend `LlamaChatSession.setChatHistory`. */
type LlamaChatHistoryItem =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: string[] };

interface LlamaChatSessionInstance {
  setChatHistory: (history: LlamaChatHistoryItem[]) => void;
  prompt: (
    text: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      onTextChunk?: (chunk: string) => void;
    }
  ) => Promise<string>;
  /** `disposeSequence: false` : la séquence du contexte sert au tour suivant. */
  dispose: (options?: { disposeSequence?: boolean }) => void;
}

/** Une demande de génération : consignes, tours précédents et question, chacun à sa place. */
export interface EmbeddedChatRequest {
  /** Les messages système du tour, réunis : consignes du mode, indications, extraits. */
  system?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** La question, brute : jamais coupée. */
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * Le signal du tour. Interrompre llama.cpp en cours de génération est l'objet de L09-10 : il
   * n'atteint pas encore `session.prompt`.
   */
  signal?: AbortSignal;
}

/**
 * La question ne tient pas dans la fenêtre du modèle embarqué, même sans consigne. Elle n'est jamais
 * coupée : le moteur couperait sa fin, ou lèverait « Failed to compress chat history ». Le code
 * remonte au renderer, qui le traduit (`chat.embeddedPromptTooLong`) ; le message reste au journal.
 */
export class EmbeddedPromptTooLongError extends Error {
  readonly code = 'embedded_prompt_too_long';

  constructor(
    readonly promptTokens: number,
    readonly budget: number
  ) {
    super(
      `The question needs ${promptTokens} tokens, more than the ${budget} that the embedded model's ` +
        `${EMBEDDED_CONTEXT_SIZE}-token context window leaves for the input.`
    );
    this.name = 'EmbeddedPromptTooLongError';
  }
}

/** Ce que `fitSystemToWindow` demande du modèle : compter, et recoller des jetons. */
export interface EmbeddedTokenizer {
  tokenize: (text: string) => ArrayLike<unknown>;
  detokenize: (tokens: readonly unknown[]) => string;
}

/** Posée à la place de la fin des consignes coupées. */
const CUT_MARK = '\n[…]';

/**
 * La tête de `text` qui tient en `room` jetons, coupée au jeton et marquée « […] » ; `text` entier
 * s'il tient. Vide quand même la marque ne tient pas.
 */
export function fitTextToTokens(text: string, room: number, tokenizer: EmbeddedTokenizer): string {
  const tokens = Array.from(tokenizer.tokenize(text));
  if (tokens.length <= room) return text;
  // Une tête recollée se retokenise parfois en quelques jetons de plus : on recule d'autant.
  let keep = room - tokenizer.tokenize(CUT_MARK).length;
  while (keep > 0) {
    // Un jeton coupé au milieu d'un caractère se recolle en caractère de remplacement.
    const head = tokenizer.detokenize(tokens.slice(0, keep)).replace(/\uFFFD+$/, '').trimEnd();
    const cut = head + CUT_MARK;
    const overshoot = tokenizer.tokenize(cut).length - room;
    if (overshoot <= 0) return cut;
    keep -= overshoot;
  }
  return '';
}

/**
 * Les consignes qui tiennent dans `budget` jetons avec la question. La question n'est jamais
 * coupée ; c'est la fin des consignes qui part, coupée au jeton et marquée « […] » : les consignes du
 * mode et les indications sont en tête, les extraits les moins pertinents et les blocs de l'auteur en
 * fin. Sans cette coupe, llama.cpp, qui ne coupe jamais la première consigne système, lève « Failed
 * to compress chat history » (mesuré). Le tour de chat retire avant elle les extraits qui ne tiennent
 * pas (`fusion-chat-service`) : elle ne frappe plus que ce qu'il ne mesure pas, le résumé du
 * compacteur en fin de consignes.
 *
 * Lève `EmbeddedPromptTooLongError` quand la question seule dépasse le budget.
 */
export function fitSystemToWindow(
  system: string,
  question: string,
  budget: number,
  tokenizer: EmbeddedTokenizer
): string {
  const questionTokens = tokenizer.tokenize(question).length;
  if (questionTokens > budget) throw new EmbeddedPromptTooLongError(questionTokens, budget);
  return fitTextToTokens(system, budget - questionTokens, tokenizer);
}

export interface EmbeddedModelInfo {
  name: string;
  filename: string;
  repo: string;
  sizeMB: number;
  contextSize: number;
  description: string;
}

export interface EmbeddedEmbeddingModelInfo {
  name: string;
  filename: string;
  repo: string;
  sizeMB: number;
  contextSize: number;
  dimensions: number;
  description: string;
  taskPrefixes?: {
    document: string;
    query: string;
  };
}

/**
 * Modèles embarqués de génération disponibles
 */
export const EMBEDDED_MODELS: Record<string, EmbeddedModelInfo> = {
  'qwen2.5-0.5b': {
    name: 'Qwen2.5-0.5B-Instruct',
    filename: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    sizeMB: 469, // Actual size: 491400032 bytes = 468.57 MB
    contextSize: 32768,
    description: 'Modèle léger (~469 Mo), rapide sur CPU, 29+ langues',
  },
  'qwen2.5-1.5b': {
    name: 'Qwen2.5-1.5B-Instruct',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    sizeMB: 1066, // Actual size: 1117320736 bytes = 1065.5 MB
    contextSize: 32768,
    description: 'Modèle équilibré (~1 Go), meilleure qualité',
  },
};

export const DEFAULT_EMBEDDED_MODEL = 'qwen2.5-0.5b';

/**
 * Modèles embarqués d'embedding disponibles
 */
export const EMBEDDED_EMBEDDING_MODELS: Record<string, EmbeddedEmbeddingModelInfo> = {
  'nomic-embed-text-v2': {
    name: 'Nomic Embed Text v2 MoE',
    filename: 'nomic-embed-text-v2-moe.Q4_K_M.gguf',
    repo: 'nomic-ai/nomic-embed-text-v2-moe-GGUF',
    sizeMB: 344,
    contextSize: 8192,
    dimensions: 768,
    description: 'Multilingue (~100 langues), 768 dims, compatible nomic-embed-text',
    taskPrefixes: {
      document: 'search_document: ',
      query: 'search_query: ',
    },
  },
};

export const DEFAULT_EMBEDDED_EMBEDDING_MODEL = 'nomic-embed-text-v2';

/**
 * Marge gardée sous la fenêtre du modèle d'embedding : le moteur ajoute les
 * jetons de début et de fin APRÈS son propre contrôle de longueur.
 */
const EMBEDDING_CONTEXT_MARGIN = 8;

/** Erreur du moteur quand l'entrée dépasse la fenêtre du modèle d'embedding. */
function isContextOverflow(error: unknown): boolean {
  return error instanceof Error && /longer than the context size/i.test(error.message);
}

/**
 * Coupe un texte en deux près du milieu, sur un blanc quand il y en a un.
 * `null` quand il n'y a plus rien à couper.
 */
function splitNearMiddle(text: string): [string, string] | null {
  if (text.length < 2) return null;
  const middle = Math.floor(text.length / 2);
  for (let offset = 0; offset < middle; offset++) {
    for (const cut of [middle + offset, middle - offset]) {
      if (!/\s/.test(text[cut])) continue;
      const left = text.slice(0, cut).trim();
      const right = text.slice(cut).trim();
      if (left && right) return [left, right];
    }
  }
  // Aucun blanc utilisable (une seule « chaîne » interminable) : coupe franche.
  return [text.slice(0, middle), text.slice(middle)];
}

/**
 * La question telle que llama.cpp la verra : les questions restées sans réponse en fin d'historique
 * la précèdent, réunies par une ligne vide, comme `LlamaChatSession.prompt()` les réunirait. C'est
 * sur ce texte que se mesure la fenêtre, et lui qui n'est jamais coupé.
 */
function closeOnQuestion(
  history: EmbeddedChatRequest['history'],
  prompt: string
): { history: EmbeddedChatRequest['history']; question: string } {
  let end = history.length;
  while (end > 0 && history[end - 1].role === 'user') end--;
  const pending = history.slice(end).map((turn) => turn.content);
  return { history: history.slice(0, end), question: [...pending, prompt].join('\n\n') };
}

/** Ce qu'un client tient : chaque modèle et son contexte. */
interface HeldModels {
  embeddingContext: LlamaEmbeddingContextInstance | null;
  embeddingModel: LlamaModelInstance | null;
  context: LlamaContextInstance | null;
  model: LlamaModelInstance | null;
}

/**
 * Tours de libération au plus pour un `dispose()` : un modèle rechargé pendant une libération est
 * libéré au tour suivant. Au-delà, le client reste suivi, et la sortie le libère.
 */
const MAX_RELEASE_ROUNDS = 3;

/** Libère un modèle chargé, sans lever : un échec ne retient pas les libérations suivantes. */
async function disposeModel(model: LlamaModelInstance | null, tag: string): Promise<void> {
  if (!model) return;
  try {
    await model.dispose();
  } catch (error) {
    console.warn(`⚠️ ${tag} Error disposing model:`, error);
  }
}

export class EmbeddedLLMClient {
  // Generation model state
  private llama: LlamaInstance | null = null;
  private model: LlamaModelInstance | null = null;
  private context: LlamaContextInstance | null = null;
  private sequence: any = null; // Store the sequence for reuse
  private modelPath: string | null = null;
  private initialized = false;
  private modelId: string | null = null;
  private isGenerating = false; // Prevent concurrent generation
  /** La libération en cours : un second appel (le registre, puis la sortie de l'app) l'attend. */
  private disposing: Promise<void> | null = null;
  /** Les chargements en cours (`initialize`, `initializeEmbedding`) : une libération les attend. */
  private readonly loads = new Set<Promise<boolean>>();

  // Embedding model state (separate from generation model)
  private embeddingModel: LlamaModelInstance | null = null;
  private embeddingContext: LlamaEmbeddingContextInstance | null = null;
  private embeddingModelPath: string | null = null;
  private embeddingModelId: string | null = null;
  private embeddingInitialized = false;
  private embeddingDimensions = 0;

  /**
   * Initialise le modèle de génération embarqué
   * @param modelPath Chemin vers le fichier GGUF
   * @param modelId ID du modèle (pour logging)
   */
  initialize(modelPath: string, modelId?: string): Promise<boolean> {
    return this.trackLoad('[EMBEDDED]', () => this.loadGeneration(modelPath, modelId));
  }

  private async loadGeneration(modelPath: string, modelId?: string): Promise<boolean> {
    try {
      // Import dynamique de node-llama-cpp
      // @ts-ignore - Module chargé dynamiquement
      const nodeLlamaCpp = await import('node-llama-cpp').catch(() => null);

      if (!nodeLlamaCpp) {
        console.warn('⚠️ [EMBEDDED] node-llama-cpp not available. Embedded LLM disabled.');
        console.warn('   Install with: npm install node-llama-cpp');
        return false;
      }

      const { getLlama } = nodeLlamaCpp;

      console.log('🤖 [EMBEDDED] Initializing embedded LLM...');
      console.log(`   Model path: ${modelPath}`);
      console.log(`   Model ID: ${modelId || 'unknown'}`);

      this.llama = (await getLlama()) as unknown as LlamaInstance;

      this.model = await this.llama.loadModel({
        modelPath: modelPath,
      });

      // Contexte optimisé pour CPU : 4 096 jetons, compromis entre capacité et performance (Q36).
      // Le compacteur et le plafond d'extraits lisent la même constante (S05-1-16).
      this.context = await this.model.createContext({
        contextSize: EMBEDDED_CONTEXT_SIZE,
        batchSize: 512,
      });

      // Get and store the sequence for reuse
      this.sequence = this.context.getSequence();

      this.modelPath = modelPath;
      this.modelId = modelId || null;
      this.initialized = true;

      console.log('✅ [EMBEDDED] Embedded LLM initialized successfully');
      return true;
    } catch (error) {
      console.error('❌ [EMBEDDED] Failed to initialize:', error);
      this.initialized = false;

      // Clean up any partially initialized resources to prevent SIGSEGV
      try {
        if (this.context) {
          await this.context.dispose();
          this.context = null;
        }
      } catch (disposeError) {
        console.warn('⚠️ [EMBEDDED] Error disposing context during cleanup:', disposeError);
      }
      // Un modèle chargé dont le contexte a échoué resterait en mémoire jusqu'à la sortie (A16).
      await disposeModel(this.model, '[EMBEDDED]');
      this.model = null;
      this.llama = null;
      this.sequence = null;
      this.modelPath = null;
      this.modelId = null;

      return false;
    }
  }

  /**
   * Initialise le modèle d'embedding embarqué (séparé du modèle de génération)
   * Réutilise l'instance Llama existante si disponible.
   */
  initializeEmbedding(modelPath: string, modelId?: string): Promise<boolean> {
    return this.trackLoad('[EMBEDDED-EMB]', () => this.loadEmbedding(modelPath, modelId));
  }

  private async loadEmbedding(modelPath: string, modelId?: string): Promise<boolean> {
    try {
      // @ts-ignore - Module chargé dynamiquement
      const nodeLlamaCpp = await import('node-llama-cpp').catch(() => null);

      if (!nodeLlamaCpp) {
        console.warn('⚠️ [EMBEDDED-EMB] node-llama-cpp not available.');
        return false;
      }

      const { getLlama } = nodeLlamaCpp;

      console.log('📐 [EMBEDDED-EMB] Initializing embedded embedding model...');
      console.log(`   Model path: ${modelPath}`);
      console.log(`   Model ID: ${modelId || 'unknown'}`);

      // Réutiliser l'instance Llama existante si disponible (singleton)
      if (!this.llama) {
        this.llama = (await getLlama()) as unknown as LlamaInstance;
      }

      this.embeddingModel = await this.llama.loadModel({
        modelPath: modelPath,
      });

      this.embeddingContext = await (this.embeddingModel as LlamaModelInstance).createEmbeddingContext();
      this.embeddingDimensions = (this.embeddingModel as any).embeddingVectorSize || 768;
      this.embeddingModelPath = modelPath;
      this.embeddingModelId = modelId || null;
      this.embeddingInitialized = true;

      console.log(`✅ [EMBEDDED-EMB] Embedding model loaded: ${modelId}, dims=${this.embeddingDimensions}`);
      return true;
    } catch (error) {
      console.error('❌ [EMBEDDED-EMB] Failed to initialize embedding model:', error);
      this.embeddingInitialized = false;

      // Cleanup
      try {
        if (this.embeddingContext) {
          await this.embeddingContext.dispose();
        }
      } catch (disposeError) {
        console.warn('⚠️ [EMBEDDED-EMB] Error disposing embedding context during cleanup:', disposeError);
      }
      await disposeModel(this.embeddingModel, '[EMBEDDED-EMB]');
      this.embeddingModel = null;
      this.embeddingContext = null;
      this.embeddingModelPath = null;
      this.embeddingModelId = null;
      this.embeddingDimensions = 0;

      return false;
    }
  }

  /**
   * Vérifie si le client de génération est disponible
   */
  async isAvailable(): Promise<boolean> {
    return this.initialized && this.model !== null && this.context !== null;
  }

  /**
   * Le tokeniseur du modèle de génération chargé, `null` sans modèle ou sans tokeniseur. Sert à
   * mesurer ce qui tiendra dans la fenêtre avant de l'envoyer : le tour de chat y retire les extraits
   * que le modèle ne lirait pas, les diapositives y coupent le document (L08-4). À n'utiliser que le
   * temps d'un appel : une libération du client rend le modèle inutilisable.
   */
  tokenizer(): EmbeddedTokenizer | null {
    const model = this.model;
    if (!model?.tokenize || !model.detokenize) return null;
    const { tokenize, detokenize } = model as LlamaModelInstance & EmbeddedTokenizer;
    // Les méthodes du modèle gardent leur `this`.
    return {
      tokenize: (text) => tokenize.call(model, text),
      detokenize: (tokens) => detokenize.call(model, tokens),
    };
  }

  /**
   * Vérifie si le modèle d'embedding est disponible
   */
  isEmbeddingAvailable(): boolean {
    return this.embeddingInitialized && this.embeddingContext !== null;
  }

  /**
   * Retourne la dimension des vecteurs d'embedding
   */
  getEmbeddingDimensions(): number {
    return this.embeddingDimensions;
  }

  /**
   * Retourne l'ID du modèle d'embedding
   */
  getEmbeddingModelId(): string | null {
    return this.embeddingModelId;
  }

  // MARK: - Embedding generation

  /** Le texte tient-il dans la fenêtre du modèle d'embedding ? */
  private fitsEmbeddingContext(input: string): boolean {
    const model = this.embeddingModel;
    const limit = model?.trainContextSize;
    // Fenêtre ou tokeniseur inconnus : on laisse le moteur trancher.
    if (!model?.tokenize || !limit) return true;
    return model.tokenize(input).length <= limit - EMBEDDING_CONTEXT_MARGIN;
  }

  /**
   * Embeddings d'un texte de longueur quelconque : un seul s'il tient dans la
   * fenêtre du modèle, sinon ceux de ses moitiés, récursivement.
   *
   * La longueur se mesure en JETONS, pas en caractères. Nomic Embed v2
   * n'accepte que 512 jetons, et le découpage par défaut produit des
   * extraits de 674 jetons en médiane (443 mots : le découpage adaptatif
   * dépasse largement les 300 mots de son réglage). Avec l'ancien seuil de
   * 2 000 caractères, le moteur refusait l'entrée (« Input is longer than
   * the context size ») et l'indexation du PDF entier échouait. Mesuré sur
   * 39 PDF réels : 72 % des extraits dépassaient, 33 PDF ne s'indexaient pas.
   *
   * Le contrôle préalable évite un aller-retour inutile vers le moteur ; le
   * rattrapage de son erreur couvre le cas où sa fenêtre réelle est plus
   * petite que celle du modèle.
   */
  private async embedFitting(text: string, prefix: string): Promise<Float32Array[]> {
    const context = this.embeddingContext as LlamaEmbeddingContextInstance;
    if (this.fitsEmbeddingContext(prefix + text)) {
      try {
        const result = await context.getEmbeddingFor(prefix + text);
        return [new Float32Array(result.vector)];
      } catch (error) {
        if (!isContextOverflow(error)) throw error;
      }
    }
    const halves = splitNearMiddle(text);
    if (!halves) {
      throw new Error('Embedded embedding: input does not fit the model context and cannot be split further.');
    }
    return [
      ...(await this.embedFitting(halves[0], prefix)),
      ...(await this.embedFitting(halves[1], prefix)),
    ];
  }

  /**
   * Moyenne plusieurs embeddings en un seul
   */
  private averageEmbeddings(embeddings: Float32Array[]): Float32Array {
    if (embeddings.length === 0) {
      throw new Error('Cannot average zero embeddings');
    }

    if (embeddings.length === 1) {
      return embeddings[0];
    }

    const length = embeddings[0].length;
    const averaged = new Float32Array(length);

    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const embedding of embeddings) {
        sum += embedding[i];
      }
      averaged[i] = sum / embeddings.length;
    }

    return averaged;
  }

  /**
   * Génère un embedding pour un texte, quelle que soit sa longueur
   * Utilise le préfixe search_document: pour l'indexation
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.embeddingContext || !this.embeddingInitialized) {
      throw new Error('Embedded embedding model not initialized. Call initializeEmbedding() first.');
    }

    const modelInfo = this.embeddingModelId
      ? EMBEDDED_EMBEDDING_MODELS[this.embeddingModelId]
      : null;
    const prefix = modelInfo?.taskPrefixes?.document || '';

    const embeddings = await this.embedFitting(text, prefix);
    if (embeddings.length > 1) {
      console.log(`📐 [EMBEDDED-EMB] Text longer than the model context, embedded in ${embeddings.length} parts`);
    }
    return this.averageEmbeddings(embeddings);
  }

  /**
   * Génère un embedding pour une requête de recherche
   * Utilise le préfixe search_query: pour la recherche
   */
  async generateQueryEmbedding(text: string): Promise<Float32Array> {
    if (!this.embeddingContext || !this.embeddingInitialized) {
      throw new Error('Embedded embedding model not initialized. Call initializeEmbedding() first.');
    }

    const modelInfo = this.embeddingModelId
      ? EMBEDDED_EMBEDDING_MODELS[this.embeddingModelId]
      : null;
    const prefix = modelInfo?.taskPrefixes?.query || '';

    // Une question collée d'un seul bloc peut dépasser la fenêtre elle aussi.
    return this.averageEmbeddings(await this.embedFitting(text, prefix));
  }

  // MARK: - Text generation

  /**
   * Génère une réponse : les consignes en vrai rôle système, les tours précédents en historique
   * structuré, la question brute (S05-1-25). Le client fabriquait une chaîne ChatML complète et la
   * passait comme texte de l'utilisateur à `LlamaChatSession.prompt()`, qui applique déjà son propre
   * gabarit : les balises restaient du texte, et le vrai rôle système était le prompt anglais par
   * défaut de node-llama-cpp. La fenêtre dépassée, c'est la fin du tout qui partait : la question.
   *
   * Les consignes sont coupées à la fenêtre (`fitSystemToWindow`) ; la question ne l'est jamais. Les
   * tours anciens qui ne tiennent pas sont effacés par la stratégie de décalage de llama.cpp, qui
   * garde la première consigne système.
   *
   * Lève avant le premier morceau quand le modèle n'est pas chargé, quand une génération est déjà en
   * cours, ou quand la question seule dépasse la fenêtre (`EmbeddedPromptTooLongError`).
   */
  async *generateChat(req: EmbeddedChatRequest): AsyncGenerator<string> {
    if (!this.context || !this.model || !this.sequence) {
      throw new Error('Embedded LLM not initialized. Call initialize() first.');
    }

    // Prevent concurrent generation
    if (this.isGenerating) {
      throw new Error('Generation already in progress. Please wait for the current generation to complete.');
    }

    this.isGenerating = true;

    try {
      // La réponse ne prend jamais plus de la moitié de la fenêtre : le budget d'entrée reste positif.
      const maxTokens = embeddedReplyTokens(EMBEDDED_CONTEXT_SIZE, req.maxTokens);
      const budget = embeddedInputBudget(EMBEDDED_CONTEXT_SIZE, req.maxTokens);
      const { history, question } = closeOnQuestion(req.history, req.prompt);
      // Fenêtre ou tokeniseur inconnus : on laisse le moteur trancher, comme pour les embeddings.
      const tokenizer = this.tokenizer();
      const system = tokenizer
        ? fitSystemToWindow(req.system ?? '', question, budget, tokenizer)
        : (req.system ?? '');
      if (req.system && system.length < req.system.length) {
        console.warn(
          `⚠️ [EMBEDDED] Consignes coupées pour tenir dans la fenêtre de ${EMBEDDED_CONTEXT_SIZE} jetons : ` +
            `${system.length} caractères gardés sur ${req.system.length}`
        );
      }

      console.log('🤖 [EMBEDDED] Generating response...', {
        systemLength: system.length,
        historyTurns: history.length,
        promptLength: question.length,
        modelId: this.modelId,
      });

      // @ts-ignore - Module chargé dynamiquement
      const nodeLlamaCpp = await import('node-llama-cpp').catch(() => null);
      if (!nodeLlamaCpp) {
        throw new Error('node-llama-cpp not available');
      }
      const { LlamaChatSession } = nodeLlamaCpp;

      // Clear the sequence state before starting a new generation
      // This resets the context to allow a fresh conversation
      await this.sequence.clearHistory();

      const session = new LlamaChatSession({
        contextSequence: this.sequence,
        systemPrompt: system || undefined,
      }) as unknown as LlamaChatSessionInstance;

      try {
        // Remplace l'historique initial, et avec lui le prompt système anglais par défaut de
        // node-llama-cpp : sans consigne, aucune consigne.
        session.setChatHistory([
          ...(system ? [{ type: 'system' as const, text: system }] : []),
          ...history.map((turn): LlamaChatHistoryItem =>
            turn.role === 'user'
              ? { type: 'user', text: turn.content }
              : { type: 'model', response: [turn.content] }
          ),
        ]);

        // Collecter la réponse avec callback pour streaming simulé
        const chunks: string[] = [];

        const response = await session.prompt(question, {
          maxTokens,
          temperature: req.temperature ?? 0.1,
          topP: req.topP ?? 0.85,
          onTextChunk: (chunk: string) => {
            chunks.push(chunk);
          },
        });

        // Si on a des chunks via callback, les utiliser pour un meilleur streaming
        if (chunks.length > 0) {
          for (const chunk of chunks) {
            yield chunk;
          }
        } else {
          // Fallback: découper la réponse en mots pour simuler le streaming
          const words = response.split(/(\s+)/);
          for (const word of words) {
            if (word) {
              yield word;
              // Petit délai pour une meilleure UX de streaming
              await new Promise((r) => setTimeout(r, 5));
            }
          }
        }

        console.log('✅ [EMBEDDED] Generation complete', {
          responseLength: response.length,
        });
      } finally {
        session.dispose({ disposeSequence: false });
      }
    } catch (error) {
      console.error('❌ [EMBEDDED] Generation error:', error);
      throw error;
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Libère les ressources du modèle : chaque contexte, puis son modèle (A16). Jamais
   * `llama.dispose()` : il libère le backend de tout le processus, celui des autres clients compris
   * (mesuré par L08).
   *
   * La promesse se résout quand le client ne tient plus aucun modèle. Un chargement en cours est
   * attendu, puis libéré : sinon son modèle serait chargé après la libération, et à la sortie. Un
   * modèle rechargé pendant la libération (un travail encore en vol) est libéré au tour suivant, au
   * plus `MAX_RELEASE_ROUNDS` tours.
   *
   * Une libération en cours est partagée : un second appel concurrent (le registre d'un service, puis
   * la sortie de l'app) reçoit la même promesse, et rien n'est libéré deux fois. Le client reste suivi
   * (`embedded-engine-pool`) jusqu'à la fin de sa libération : la sortie attend une libération
   * commencée ailleurs, au lieu de trouver le suivi vide et de quitter avant `model.dispose()`.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.releaseAll().finally(() => {
      this.disposing = null;
      this.forgetIfIdle();
    });
    return this.disposing;
  }

  /**
   * Un chargement est visible de la sortie dès son début, et une libération l'attend. Une fois la
   * sortie commencée, aucun modèle ne se charge plus : il serait chargé au moment d'`app.exit`.
   * La vérification et l'inscription sont synchrones : un chargement est soit suivi, soit refusé.
   */
  private trackLoad(tag: string, load: () => Promise<boolean>): Promise<boolean> {
    if (isEmbeddedEngineClosing()) {
      console.warn(`⚠️ ${tag} Sortie en cours : le modèle n'est pas chargé.`);
      return Promise.resolve(false);
    }
    trackEmbeddedClient(this);
    const loading = load();
    this.loads.add(loading);
    const settled = (): void => {
      this.loads.delete(loading);
      this.forgetIfIdle();
    };
    void loading.then(settled, settled);
    return loading;
  }

  /** Un modèle est chargé, même à moitié (son contexte pas encore créé). */
  private holdsModel(): boolean {
    return this.model !== null || this.embeddingModel !== null;
  }

  /** Le client ne tient plus rien, ne charge rien et ne libère rien : la sortie n'a plus à le voir. */
  private forgetIfIdle(): void {
    if (this.loads.size === 0 && this.disposing === null && !this.holdsModel()) {
      forgetEmbeddedClient(this);
    }
  }

  private async releaseAll(): Promise<void> {
    for (let round = 1; ; round++) {
      // Wait for any ongoing generation to complete
      if (this.isGenerating) {
        console.log('⏳ [EMBEDDED] Waiting for generation to complete before disposing...');
        // Give it a moment to finish
        await new Promise((r) => setTimeout(r, 500));
      }
      // Un chargement en cours finirait après la libération, son modèle chargé : on attend qu'il
      // aboutisse (ou échoue) pour le libérer avec le reste.
      while (this.loads.size > 0) {
        await Promise.allSettled([...this.loads]);
      }
      // Aucun `await` entre la dernière vérification et la prise : aucun chargement n'est en cours.
      await this.release(this.takeModels());
      if (this.loads.size === 0 && !this.holdsModel()) return;
      if (round >= MAX_RELEASE_ROUNDS) {
        console.warn('⚠️ [EMBEDDED] Modèle rechargé pendant chaque libération : il reste suivi pour la sortie.');
        return;
      }
    }
  }

  /** Prend les modèles et leurs contextes, et vide le client : plus aucun appel ne les trouve. */
  private takeModels(): HeldModels {
    const held: HeldModels = {
      embeddingContext: this.embeddingContext,
      embeddingModel: this.embeddingModel,
      context: this.context,
      model: this.model,
    };

    this.embeddingModel = null;
    this.embeddingContext = null;
    this.embeddingModelPath = null;
    this.embeddingModelId = null;
    this.embeddingInitialized = false;
    this.embeddingDimensions = 0;

    this.model = null;
    this.llama = null;
    this.context = null;
    this.sequence = null;
    this.initialized = false;
    this.modelPath = null;
    this.modelId = null;
    this.isGenerating = false;

    return held;
  }

  private async release({ embeddingContext, embeddingModel, context, model }: HeldModels): Promise<void> {
    // Dispose embedding resources
    try {
      if (embeddingContext) {
        await embeddingContext.dispose();
      }
    } catch (error) {
      console.warn('⚠️ [EMBEDDED] Error disposing embedding context:', error);
    }
    await disposeModel(embeddingModel, '[EMBEDDED]');

    // Dispose generation resources
    try {
      if (context) {
        await context.dispose();
      }
    } catch (error) {
      console.warn('⚠️ [EMBEDDED] Error disposing context:', error);
    }
    await disposeModel(model, '[EMBEDDED]');

    console.log('🧹 [EMBEDDED] Resources disposed');
  }

  /**
   * Retourne le chemin du modèle actuel
   */
  getModelPath(): string | null {
    return this.modelPath;
  }

  /**
   * Retourne l'ID du modèle actuel
   */
  getModelId(): string | null {
    return this.modelId;
  }

  /**
   * Retourne si le client est initialisé
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
