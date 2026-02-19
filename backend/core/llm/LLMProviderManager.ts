/**
 * Gestionnaire de providers LLM
 * Permet de basculer entre Ollama et le modèle embarqué selon la configuration
 * et la disponibilité des services.
 *
 * Supporte le routage des embeddings vers Ollama ou le modèle embarqué.
 */

import fs from 'fs';
import { OllamaClient, GENERATION_PRESETS } from './OllamaClient.js';
import { EmbeddedLLMClient, DEFAULT_EMBEDDED_MODEL } from './EmbeddedLLMClient.js';
import type { SearchResult } from '../../types/pdf-document.js';

export type LLMProvider = 'ollama' | 'embedded' | 'auto';

export interface LLMProviderConfig {
  /** Provider préféré: 'ollama', 'embedded', ou 'auto' (essaie ollama puis embedded) */
  provider: LLMProvider;
  /** Chemin vers le modèle GGUF embarqué */
  embeddedModelPath?: string;
  /** ID du modèle embarqué */
  embeddedModelId?: string;
  /** URL de l'API Ollama */
  ollamaURL?: string;
  /** Modèle de chat Ollama */
  ollamaChatModel?: string;
  /** Modèle d'embeddings Ollama */
  ollamaEmbeddingModel?: string;
  /** Stratégie d'embeddings: 'nomic-fallback', 'mxbai-only', 'custom' */
  embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom';
  /** Chemin vers le modèle d'embedding GGUF embarqué */
  embeddedEmbeddingModelPath?: string;
  /** ID du modèle d'embedding embarqué */
  embeddedEmbeddingModelId?: string;
  /** Provider pour les embeddings: 'ollama', 'embedded', ou 'auto' */
  embeddingProvider?: 'ollama' | 'embedded' | 'auto';
}

export interface ProviderStatus {
  activeProvider: 'ollama' | 'embedded' | null;
  ollamaAvailable: boolean;
  embeddedAvailable: boolean;
  embeddedModelId: string | null;
  ollamaModel: string;
  embeddedEmbeddingAvailable: boolean;
  embeddedEmbeddingModelId: string | null;
}

export class LLMProviderManager {
  private ollamaClient: OllamaClient;
  private embeddedClient: EmbeddedLLMClient;
  private config: LLMProviderConfig;
  private embeddedAvailable = false;
  private embeddedEmbeddingAvailable = false;
  private activeProvider: 'ollama' | 'embedded' | null = null;
  private initialized = false;

  constructor(config: LLMProviderConfig) {
    this.config = config;

    // Initialiser le client Ollama
    this.ollamaClient = new OllamaClient(
      config.ollamaURL || 'http://127.0.0.1:11434',
      config.ollamaChatModel,
      config.ollamaEmbeddingModel,
      config.embeddingStrategy || 'nomic-fallback'
    );

    // Initialiser le client embarqué (non chargé tant qu'on n'appelle pas initialize)
    this.embeddedClient = new EmbeddedLLMClient();
  }

  /**
   * Initialise le manager et charge les modèles embarqués si disponibles
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log('🔧 [PROVIDER] Initializing LLM Provider Manager...');
    console.log(`   Configured provider: ${this.config.provider}`);
    console.log(`   Embedded model path: ${this.config.embeddedModelPath || 'not set'}`);
    console.log(`   Embedded embedding model path: ${this.config.embeddedEmbeddingModelPath || 'not set'}`);

    // Initialiser le modèle de génération embarqué si un chemin est fourni et le fichier existe
    if (this.config.embeddedModelPath) {
      if (!fs.existsSync(this.config.embeddedModelPath)) {
        console.log(`⏭️ [PROVIDER] Embedded model not found, skipping: ${this.config.embeddedModelPath}`);
        this.embeddedAvailable = false;
      } else {
        try {
          const success = await this.embeddedClient.initialize(
            this.config.embeddedModelPath,
            this.config.embeddedModelId
          );
          this.embeddedAvailable = success;
          if (success) {
            console.log('✅ [PROVIDER] Embedded model loaded successfully');
          }
        } catch (error) {
          console.warn('⚠️ [PROVIDER] Could not load embedded model:', error);
          this.embeddedAvailable = false;
        }
      }
    }

    // Initialiser le modèle d'embedding embarqué si un chemin est fourni
    if (this.config.embeddedEmbeddingModelPath) {
      if (!fs.existsSync(this.config.embeddedEmbeddingModelPath)) {
        console.log(`⏭️ [PROVIDER] Embedded embedding model not found, skipping: ${this.config.embeddedEmbeddingModelPath}`);
        this.embeddedEmbeddingAvailable = false;
      } else {
        try {
          const success = await this.embeddedClient.initializeEmbedding(
            this.config.embeddedEmbeddingModelPath,
            this.config.embeddedEmbeddingModelId
          );
          this.embeddedEmbeddingAvailable = success;
          if (success) {
            console.log('✅ [PROVIDER] Embedded embedding model loaded successfully');
          }
        } catch (error) {
          console.warn('⚠️ [PROVIDER] Could not load embedded embedding model:', error);
          this.embeddedEmbeddingAvailable = false;
        }
      }
    }

    this.initialized = true;

    // Déterminer le provider actif initial
    await this.getActiveProvider();

    console.log(`✅ [PROVIDER] Initialized. Active provider: ${this.activeProvider || 'none'}, Embedding: ${this.embeddedEmbeddingAvailable ? 'embedded available' : 'Ollama only'}`);
  }

  /**
   * Détermine quel provider utiliser selon la config et la disponibilité
   */
  async getActiveProvider(): Promise<'ollama' | 'embedded' | null> {
    // Si provider explicitement forcé
    if (this.config.provider === 'ollama') {
      const available = await this.ollamaClient.isAvailable();
      this.activeProvider = available ? 'ollama' : null;
      return this.activeProvider;
    }

    if (this.config.provider === 'embedded') {
      this.activeProvider = this.embeddedAvailable ? 'embedded' : null;
      return this.activeProvider;
    }

    // Mode 'auto': essayer Ollama d'abord, puis embedded
    const ollamaAvailable = await this.ollamaClient.isAvailable();
    if (ollamaAvailable) {
      this.activeProvider = 'ollama';
      return 'ollama';
    }

    if (this.embeddedAvailable) {
      this.activeProvider = 'embedded';
      return 'embedded';
    }

    this.activeProvider = null;
    return null;
  }

  /**
   * Retourne le statut complet des providers
   */
  async getStatus(): Promise<ProviderStatus> {
    const ollamaAvailable = await this.ollamaClient.isAvailable();

    return {
      activeProvider: this.activeProvider,
      ollamaAvailable,
      embeddedAvailable: this.embeddedAvailable,
      embeddedModelId: this.embeddedClient.getModelId(),
      ollamaModel: this.ollamaClient.chatModel,
      embeddedEmbeddingAvailable: this.embeddedEmbeddingAvailable,
      embeddedEmbeddingModelId: this.embeddedClient.getEmbeddingModelId(),
    };
  }

  /**
   * Retourne le nom lisible du provider actif (pour affichage UI)
   */
  getActiveProviderName(): string {
    switch (this.activeProvider) {
      case 'ollama':
        return `Ollama (${this.ollamaClient.chatModel})`;
      case 'embedded':
        const modelId = this.embeddedClient.getModelId() || DEFAULT_EMBEDDED_MODEL;
        return `${modelId} (embarqué)`;
      default:
        return 'Aucun LLM disponible';
    }
  }

  /**
   * Retourne le nom du modèle actif (sans le nom du provider)
   */
  getActiveModelName(): string {
    switch (this.activeProvider) {
      case 'ollama':
        return this.ollamaClient.chatModel;
      case 'embedded':
        return this.embeddedClient.getModelId() || DEFAULT_EMBEDDED_MODEL;
      default:
        return 'aucun';
    }
  }

  /**
   * Génère une réponse avec sources via le provider actif
   */
  async *generateWithSources(
    prompt: string,
    sources: SearchResult[],
    projectContext?: string,
    options?: {
      model?: string;
      timeout?: number;
      generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & { num_ctx?: number };
      systemPrompt?: string;
    }
  ): AsyncGenerator<string> {
    const provider = await this.getActiveProvider();

    if (!provider) {
      throw new Error(
        'Aucun provider LLM disponible.\n\n' +
          'Options:\n' +
          '1. Installez et démarrez Ollama (https://ollama.ai)\n' +
          '2. Téléchargez le modèle embarqué dans Paramètres → LLM'
      );
    }

    console.log(`🤖 [PROVIDER] Generating with: ${provider}`);

    if (provider === 'ollama') {
      yield* this.ollamaClient.generateResponseStreamWithSources(
        prompt,
        sources,
        projectContext,
        options?.model,
        options?.timeout,
        options?.generationOptions,
        options?.systemPrompt
      );
    } else {
      yield* this.embeddedClient.generateResponseStreamWithSources(
        prompt,
        sources,
        projectContext,
        options?.systemPrompt
      );
    }
  }

  /**
   * Génère une réponse sans sources (contexte simple)
   */
  async *generateWithoutSources(
    prompt: string,
    context: string[],
    options?: {
      model?: string;
      timeout?: number;
      generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & { num_ctx?: number };
      systemPrompt?: string;
    }
  ): AsyncGenerator<string> {
    const provider = await this.getActiveProvider();

    if (!provider) {
      throw new Error('Aucun provider LLM disponible.');
    }

    console.log(`🤖 [PROVIDER] Generating (no sources) with: ${provider}`);

    if (provider === 'ollama') {
      yield* this.ollamaClient.generateResponseStream(
        prompt,
        context,
        options?.model,
        options?.timeout,
        options?.generationOptions,
        options?.systemPrompt
      );
    } else {
      yield* this.embeddedClient.generateResponseStream(
        prompt,
        context,
        options?.systemPrompt
      );
    }
  }

  // MARK: - Embedding generation

  /**
   * Génère un embedding pour un document (indexation).
   * Route vers Ollama ou le modèle embarqué selon la config et la disponibilité.
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    const embeddingProvider = this.config.embeddingProvider || 'auto';

    if (embeddingProvider === 'ollama') {
      const ollamaAvailable = await this.ollamaClient.isAvailable();
      if (ollamaAvailable) {
        return this.ollamaClient.generateEmbedding(text);
      }
      throw new Error(
        'Ollama est requis pour les embeddings (mode forcé) mais n\'est pas disponible.\n' +
        'Installez et démarrez Ollama: https://ollama.ai'
      );
    }

    if (embeddingProvider === 'embedded') {
      if (this.embeddedEmbeddingAvailable) {
        return this.embeddedClient.generateEmbedding(text);
      }
      throw new Error(
        'Le modèle d\'embedding embarqué n\'est pas disponible.\n' +
        'Téléchargez-le dans Paramètres → LLM.'
      );
    }

    // Mode 'auto': essayer Ollama d'abord, puis embarqué
    const ollamaAvailable = await this.ollamaClient.isAvailable();
    if (ollamaAvailable) {
      return this.ollamaClient.generateEmbedding(text);
    }

    if (this.embeddedEmbeddingAvailable) {
      return this.embeddedClient.generateEmbedding(text);
    }

    throw new Error(
      'Aucun provider d\'embeddings disponible.\n\n' +
      'Options:\n' +
      '1. Installez et démarrez Ollama (https://ollama.ai)\n' +
      '2. Téléchargez le modèle d\'embedding embarqué dans Paramètres → LLM'
    );
  }

  /**
   * Génère un embedding pour une requête de recherche.
   * Pour Ollama, identique à generateEmbedding.
   * Pour le modèle embarqué, utilise le préfixe search_query:.
   */
  async generateQueryEmbedding(text: string): Promise<Float32Array> {
    const embeddingProvider = this.config.embeddingProvider || 'auto';

    if (embeddingProvider === 'ollama') {
      const ollamaAvailable = await this.ollamaClient.isAvailable();
      if (ollamaAvailable) {
        return this.ollamaClient.generateEmbedding(text);
      }
      throw new Error('Ollama est requis pour les embeddings mais n\'est pas disponible.');
    }

    if (embeddingProvider === 'embedded') {
      if (this.embeddedEmbeddingAvailable) {
        return this.embeddedClient.generateQueryEmbedding(text);
      }
      throw new Error('Le modèle d\'embedding embarqué n\'est pas disponible.');
    }

    // Mode 'auto'
    const ollamaAvailable = await this.ollamaClient.isAvailable();
    if (ollamaAvailable) {
      return this.ollamaClient.generateEmbedding(text);
    }

    if (this.embeddedEmbeddingAvailable) {
      return this.embeddedClient.generateQueryEmbedding(text);
    }

    throw new Error(
      'Aucun provider d\'embeddings disponible.\n\n' +
      'Options:\n' +
      '1. Installez et démarrez Ollama (https://ollama.ai)\n' +
      '2. Téléchargez le modèle d\'embedding embarqué dans Paramètres → LLM'
    );
  }

  /**
   * Vérifie si les embeddings sont disponibles (Ollama OU embarqué)
   */
  async isEmbeddingAvailable(): Promise<boolean> {
    const ollamaAvailable = await this.ollamaClient.isAvailable();
    return ollamaAvailable || this.embeddedEmbeddingAvailable;
  }

  /**
   * Vérifie si Ollama est disponible
   */
  async isOllamaAvailable(): Promise<boolean> {
    return this.ollamaClient.isAvailable();
  }

  /**
   * Vérifie si le modèle embarqué de génération est disponible
   */
  isEmbeddedAvailable(): boolean {
    return this.embeddedAvailable;
  }

  /**
   * Vérifie si le modèle d'embedding embarqué est disponible
   */
  isEmbeddedEmbeddingAvailable(): boolean {
    return this.embeddedEmbeddingAvailable;
  }

  /**
   * Retourne le client Ollama (pour compatibilité avec le code existant)
   */
  getOllamaClient(): OllamaClient {
    return this.ollamaClient;
  }

  /**
   * Retourne le client embarqué
   */
  getEmbeddedClient(): EmbeddedLLMClient {
    return this.embeddedClient;
  }

  /**
   * Met à jour la configuration du provider préféré
   */
  setProvider(provider: LLMProvider): void {
    console.log(`🔧 [PROVIDER] Setting provider preference to: ${provider}`);
    this.config.provider = provider;
    this.activeProvider = null; // Force recalcul au prochain appel
  }

  /**
   * Met à jour le chemin du modèle de génération embarqué et réinitialise
   */
  async setEmbeddedModelPath(path: string, modelId?: string): Promise<boolean> {
    console.log(`🔧 [PROVIDER] Setting embedded model path: ${path}`);

    // Libérer l'ancien modèle
    await this.embeddedClient.dispose();

    // Charger le nouveau
    this.config.embeddedModelPath = path;
    this.config.embeddedModelId = modelId;

    const success = await this.embeddedClient.initialize(path, modelId);
    this.embeddedAvailable = success;

    // Recharger le modèle d'embedding si configuré (dispose l'a libéré)
    if (this.config.embeddedEmbeddingModelPath && fs.existsSync(this.config.embeddedEmbeddingModelPath)) {
      const embSuccess = await this.embeddedClient.initializeEmbedding(
        this.config.embeddedEmbeddingModelPath,
        this.config.embeddedEmbeddingModelId
      );
      this.embeddedEmbeddingAvailable = embSuccess;
    }

    // Recalculer le provider actif
    await this.getActiveProvider();

    return success;
  }

  /**
   * Met à jour le chemin du modèle d'embedding embarqué
   */
  async setEmbeddedEmbeddingModelPath(path: string, modelId?: string): Promise<boolean> {
    console.log(`🔧 [PROVIDER] Setting embedded embedding model path: ${path}`);

    this.config.embeddedEmbeddingModelPath = path;
    this.config.embeddedEmbeddingModelId = modelId;

    const success = await this.embeddedClient.initializeEmbedding(path, modelId);
    this.embeddedEmbeddingAvailable = success;

    return success;
  }

  /**
   * Désactive le modèle de génération embarqué
   */
  async disableEmbedded(): Promise<void> {
    await this.embeddedClient.dispose();
    this.embeddedAvailable = false;
    this.embeddedEmbeddingAvailable = false;
    this.config.embeddedModelPath = undefined;

    // Recalculer le provider actif
    await this.getActiveProvider();
  }

  /**
   * Désactive le modèle d'embedding embarqué
   * Note: ne libère pas l'instance Llama car le modèle de génération peut encore l'utiliser
   */
  async disableEmbeddedEmbedding(): Promise<void> {
    // On ne peut pas dispose sélectivement l'embedding sans dispose tout.
    // Le modèle d'embedding sera libéré au prochain dispose() complet.
    this.embeddedEmbeddingAvailable = false;
    this.config.embeddedEmbeddingModelPath = undefined;
    this.config.embeddedEmbeddingModelId = undefined;
    console.log('🔧 [PROVIDER] Embedded embedding model disabled');
  }

  /**
   * Libère toutes les ressources
   */
  async dispose(): Promise<void> {
    console.log('🧹 [PROVIDER] Disposing LLM Provider Manager...');
    await this.embeddedClient.dispose();
    this.embeddedEmbeddingAvailable = false;
    this.initialized = false;
    this.activeProvider = null;
  }

  /**
   * Retourne la configuration actuelle
   */
  getConfig(): LLMProviderConfig {
    return { ...this.config };
  }
}
