/**
 * Client LLM embarqué utilisant node-llama-cpp
 * Modèle par défaut: Qwen2.5-0.5B-Instruct (~491 Mo)
 *
 * IMPORTANT: Ce client ne gère que la génération de texte.
 * Les embeddings restent via OllamaClient (nomic-embed-text).
 */
import type { SearchResult } from '../../types/pdf-document.js';
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
export declare const EMBEDDED_MODELS: Record<string, EmbeddedModelInfo>;
export declare const DEFAULT_EMBEDDED_MODEL = "qwen2.5-0.5b";
export declare class EmbeddedLLMClient {
    private llama;
    private model;
    private context;
    private sequence;
    private modelPath;
    private initialized;
    private modelId;
    private isGenerating;
    /**
     * Initialise le modèle embarqué
     * @param modelPath Chemin vers le fichier GGUF
     * @param modelId ID du modèle (pour logging)
     */
    initialize(modelPath: string, modelId?: string): Promise<boolean>;
    /**
     * Vérifie si le client est disponible
     */
    isAvailable(): Promise<boolean>;
    /**
     * Construit le prompt pour Qwen au format ChatML
     * Qwen utilise le format <|im_start|> / <|im_end|>
     */
    private buildPromptWithSources;
    /**
     * Génère une réponse avec sources (streaming)
     */
    generateResponseStreamWithSources(prompt: string, sources: SearchResult[], projectContext?: string, systemPrompt?: string): AsyncGenerator<string>;
    /**
     * Génère une réponse sans sources (contexte simple)
     */
    generateResponseStream(prompt: string, context: string[], systemPrompt?: string): AsyncGenerator<string>;
    /**
     * Libère les ressources du modèle
     */
    dispose(): Promise<void>;
    /**
     * Retourne le chemin du modèle actuel
     */
    getModelPath(): string | null;
    /**
     * Retourne l'ID du modèle actuel
     */
    getModelId(): string | null;
    /**
     * Retourne si le client est initialisé
     */
    isInitialized(): boolean;
}
