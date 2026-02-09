/**
 * Client LLM embarqué utilisant node-llama-cpp
 * Modèle par défaut: Qwen2.5-0.5B-Instruct (~491 Mo)
 *
 * IMPORTANT: Ce client ne gère que la génération de texte.
 * Les embeddings restent via OllamaClient (nomic-embed-text).
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
}

interface LlamaContextInstance {
  getSequence: () => any;
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

/**
 * Modèles embarqués disponibles
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

export class EmbeddedLLMClient {
  private llama: LlamaInstance | null = null;
  private model: LlamaModelInstance | null = null;
  private context: LlamaContextInstance | null = null;
  private sequence: any = null; // Store the sequence for reuse
  private modelPath: string | null = null;
  private initialized = false;
  private modelId: string | null = null;
  private isGenerating = false; // Prevent concurrent generation

  /**
   * Initialise le modèle embarqué
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
   * Vérifie si le client est disponible
   */
  async isAvailable(): Promise<boolean> {
    return this.initialized && this.model !== null && this.context !== null;
  }

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
