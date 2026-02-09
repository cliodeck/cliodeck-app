/**
 * Gestionnaire de providers LLM
 * Permet de basculer entre Ollama et le modèle embarqué selon la configuration
 * et la disponibilité des services.
 */
import { OllamaClient, GENERATION_PRESETS } from './OllamaClient.js';
import { EmbeddedLLMClient } from './EmbeddedLLMClient.js';
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
}
export interface ProviderStatus {
    activeProvider: 'ollama' | 'embedded' | null;
    ollamaAvailable: boolean;
    embeddedAvailable: boolean;
    embeddedModelId: string | null;
    ollamaModel: string;
}
export declare class LLMProviderManager {
    private ollamaClient;
    private embeddedClient;
    private config;
    private embeddedAvailable;
    private activeProvider;
    private initialized;
    constructor(config: LLMProviderConfig);
    /**
     * Initialise le manager et charge le modèle embarqué si disponible
     */
    initialize(): Promise<void>;
    /**
     * Détermine quel provider utiliser selon la config et la disponibilité
     */
    getActiveProvider(): Promise<'ollama' | 'embedded' | null>;
    /**
     * Retourne le statut complet des providers
     */
    getStatus(): Promise<ProviderStatus>;
    /**
     * Retourne le nom lisible du provider actif (pour affichage UI)
     */
    getActiveProviderName(): string;
    /**
     * Retourne le nom du modèle actif (sans le nom du provider)
     */
    getActiveModelName(): string;
    /**
     * Génère une réponse avec sources via le provider actif
     */
    generateWithSources(prompt: string, sources: SearchResult[], projectContext?: string, options?: {
        model?: string;
        timeout?: number;
        generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & {
            num_ctx?: number;
        };
        systemPrompt?: string;
    }): AsyncGenerator<string>;
    /**
     * Génère une réponse sans sources (contexte simple)
     */
    generateWithoutSources(prompt: string, context: string[], options?: {
        model?: string;
        timeout?: number;
        generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & {
            num_ctx?: number;
        };
        systemPrompt?: string;
    }): AsyncGenerator<string>;
    /**
     * Génère un embedding (toujours via Ollama)
     * IMPORTANT: Le modèle embarqué Qwen n'est PAS un modèle d'embeddings.
     * Les embeddings nécessitent Ollama avec nomic-embed-text ou similaire.
     */
    generateEmbedding(text: string): Promise<Float32Array>;
    /**
     * Vérifie si les embeddings sont disponibles (Ollama requis)
     */
    isEmbeddingAvailable(): Promise<boolean>;
    /**
     * Vérifie si Ollama est disponible
     */
    isOllamaAvailable(): Promise<boolean>;
    /**
     * Vérifie si le modèle embarqué est disponible
     */
    isEmbeddedAvailable(): boolean;
    /**
     * Retourne le client Ollama (pour compatibilité avec le code existant)
     */
    getOllamaClient(): OllamaClient;
    /**
     * Retourne le client embarqué
     */
    getEmbeddedClient(): EmbeddedLLMClient;
    /**
     * Met à jour la configuration du provider préféré
     */
    setProvider(provider: LLMProvider): void;
    /**
     * Met à jour le chemin du modèle embarqué et réinitialise
     */
    setEmbeddedModelPath(path: string, modelId?: string): Promise<boolean>;
    /**
     * Désactive le modèle embarqué
     */
    disableEmbedded(): Promise<void>;
    /**
     * Libère toutes les ressources
     */
    dispose(): Promise<void>;
    /**
     * Retourne la configuration actuelle
     */
    getConfig(): LLMProviderConfig;
}
