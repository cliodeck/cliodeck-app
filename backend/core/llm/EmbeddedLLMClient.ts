/**
 * Client LLM embarqué utilisant node-llama-cpp
 * Modèle par défaut: Qwen2.5-0.5B-Instruct (~491 Mo)
 *
 * Supporte la génération de texte ET les embeddings via des modèles GGUF séparés.
 */

import type { SearchResult } from '../../types/pdf-document.js';

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
}

interface LlamaContextInstance {
  getSequence: () => any;
  dispose: () => Promise<void>;
}

interface LlamaEmbeddingContextInstance {
  getEmbeddingFor: (text: string) => Promise<{ vector: number[] }>;
  dispose: () => Promise<void>;
}

interface LlamaChatSessionInstance {
  prompt: (
    text: string,
    options?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      onTextChunk?: (chunk: string) => void;
    }
  ) => Promise<string>;
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

  // Embedding model state (separate from generation model)
  private embeddingModel: LlamaModelInstance | null = null;
  private embeddingContext: LlamaEmbeddingContextInstance | null = null;
  private embeddingModelPath: string | null = null;
  private embeddingModelId: string | null = null;
  private embeddingInitialized = false;
  private embeddingDimensions = 0;

  // Limite de caractères par chunk pour les embeddings
  private readonly EMBEDDING_MAX_CHUNK_LENGTH = 2000;

  /**
   * Initialise le modèle de génération embarqué
   * @param modelPath Chemin vers le fichier GGUF
   * @param modelId ID du modèle (pour logging)
   */
  async initialize(modelPath: string, modelId?: string): Promise<boolean> {
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

      // Contexte optimisé pour CPU - utiliser une taille raisonnable
      // 4096 tokens est un bon compromis entre capacité et performance
      this.context = await this.model.createContext({
        contextSize: 4096,
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
  async initializeEmbedding(modelPath: string, modelId?: string): Promise<boolean> {
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

  /**
   * Découpe un texte en chunks de taille maximale (sentence-aware)
   */
  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks: string[] = [];
    let currentIndex = 0;

    while (currentIndex < text.length) {
      let endIndex = Math.min(currentIndex + maxLength, text.length);

      // Try to find sentence boundary if not at end
      if (endIndex < text.length) {
        const searchStart = Math.max(currentIndex, endIndex - 200);
        const searchText = text.substring(searchStart, endIndex);
        const sentenceEndings = /[.!?;](?=\s|$)/g;
        let lastMatch = null;
        let match;

        while ((match = sentenceEndings.exec(searchText)) !== null) {
          lastMatch = match;
        }

        if (lastMatch) {
          endIndex = searchStart + lastMatch.index + 1;
        }
      }

      const chunk = text.substring(currentIndex, endIndex).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      currentIndex = endIndex;
    }

    return chunks;
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
   * Génère un embedding pour un texte (avec chunking automatique si nécessaire)
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

    // Si le texte est court, traitement direct
    if (text.length <= this.EMBEDDING_MAX_CHUNK_LENGTH) {
      const result = await this.embeddingContext.getEmbeddingFor(prefix + text);
      return new Float32Array(result.vector);
    }

    // Chunking automatique pour les textes longs
    const chunks = this.chunkText(text, this.EMBEDDING_MAX_CHUNK_LENGTH);
    console.log(`📐 [EMBEDDED-EMB] Text too long (${text.length} chars), splitting into ${chunks.length} chunks`);

    const embeddings: Float32Array[] = [];
    for (const chunk of chunks) {
      const result = await this.embeddingContext.getEmbeddingFor(prefix + chunk);
      embeddings.push(new Float32Array(result.vector));
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

    const result = await this.embeddingContext.getEmbeddingFor(prefix + text);
    return new Float32Array(result.vector);
  }

  // MARK: - Text generation

  /**
   * Construit le prompt pour Qwen au format ChatML
   * Qwen utilise le format <|im_start|> / <|im_end|>
   */
  private buildPromptWithSources(
    userQuery: string,
    sources: SearchResult[],
    projectContext?: string,
    systemPrompt?: string
  ): string {
    // System prompt par défaut adapté au RAG académique
    const defaultSystemPrompt =
      systemPrompt ||
      `Tu es un assistant académique spécialisé dans l'analyse de documents de recherche.
Tu réponds de manière précise et avec des citations à l'appui, en te basant uniquement sur les sources fournies.
Cite toujours tes sources avec le format (Auteur, Année, p. X).
Si les sources ne contiennent pas l'information demandée, dis-le clairement.

IMPORTANT concernant les scores de pertinence:
- Chaque source est accompagnée d'un score de pertinence (0-100%).
- Priorise les sources avec une pertinence élevée (>50%) dans ta réponse.
- Sois prudent avec les sources de faible pertinence (<30%) - elles peuvent être moins fiables pour la question posée.
- Les sources sont triées par pertinence décroissante.`;

    let contextSection = '';

    // Ajouter le contexte du projet si disponible
    if (projectContext) {
      contextSection += `\n\nContexte du projet:\n${projectContext}`;
    }

    // Ajouter les sources documentaires triées par pertinence
    // Issue #15: Ne plus afficher les scores de similarité au LLM
    if (sources.length > 0) {
      contextSection += '\n\nSources documentaires:';

      // Trier les sources par pertinence décroissante
      const sortedSources = [...sources].sort((a, b) => b.similarity - a.similarity);

      sortedSources.forEach((source, idx) => {
        const doc = source.document;
        const ref = doc.author
          ? `${doc.author}${doc.year ? ` (${doc.year})` : ''}`
          : doc.title;
        contextSection += `\n\n[Source ${idx + 1} - ${ref}, p. ${source.chunk.pageNumber}]\n${source.chunk.content}`;
      });
    }

    // Format ChatML pour Qwen
    return `<|im_start|>system
${defaultSystemPrompt}${contextSection}
<|im_end|>
<|im_start|>user
${userQuery}
<|im_end|>
<|im_start|>assistant
`;
  }

  /**
   * Génère une réponse avec sources (streaming)
   */
  async *generateResponseStreamWithSources(
    prompt: string,
    sources: SearchResult[],
    projectContext?: string,
    systemPrompt?: string
  ): AsyncGenerator<string> {
    if (!this.context || !this.model || !this.sequence) {
      throw new Error('Embedded LLM not initialized. Call initialize() first.');
    }

    // Prevent concurrent generation
    if (this.isGenerating) {
      throw new Error('Generation already in progress. Please wait for the current generation to complete.');
    }

    this.isGenerating = true;

    const fullPrompt = this.buildPromptWithSources(
      prompt,
      sources,
      projectContext,
      systemPrompt
    );

    console.log('🤖 [EMBEDDED] Generating response...', {
      promptLength: fullPrompt.length,
      sourcesCount: sources.length,
      modelId: this.modelId,
    });

    try {
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
      }) as unknown as LlamaChatSessionInstance;

      // Collecter la réponse avec callback pour streaming simulé
      const chunks: string[] = [];

      const response = await session.prompt(fullPrompt, {
        maxTokens: 2048,
        temperature: 0.1,
        topP: 0.85,
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
    } catch (error) {
      console.error('❌ [EMBEDDED] Generation error:', error);
      throw error;
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * Génère une réponse sans sources (contexte simple)
   */
  async *generateResponseStream(
    prompt: string,
    context: string[],
    systemPrompt?: string
  ): AsyncGenerator<string> {
    // Convertir le contexte simple en format utilisable
    yield* this.generateResponseStreamWithSources(
      prompt,
      [],
      context.join('\n'),
      systemPrompt
    );
  }

  /**
   * Libère les ressources du modèle
   */
  async dispose(): Promise<void> {
    // Wait for any ongoing generation to complete
    if (this.isGenerating) {
      console.log('⏳ [EMBEDDED] Waiting for generation to complete before disposing...');
      // Give it a moment to finish
      await new Promise((r) => setTimeout(r, 500));
    }

    // Dispose embedding resources
    try {
      if (this.embeddingContext) {
        await this.embeddingContext.dispose();
      }
    } catch (error) {
      console.warn('⚠️ [EMBEDDED] Error disposing embedding context:', error);
    }

    this.embeddingModel = null;
    this.embeddingContext = null;
    this.embeddingModelPath = null;
    this.embeddingModelId = null;
    this.embeddingInitialized = false;
    this.embeddingDimensions = 0;

    // Dispose generation resources
    try {
      if (this.context) {
        await this.context.dispose();
      }
    } catch (error) {
      console.warn('⚠️ [EMBEDDED] Error disposing context:', error);
    }

    this.model = null;
    this.llama = null;
    this.context = null;
    this.sequence = null;
    this.initialized = false;
    this.modelPath = null;
    this.modelId = null;
    this.isGenerating = false;

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
