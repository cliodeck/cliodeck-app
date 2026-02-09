/**
 * Gestionnaire de providers LLM
 * Permet de basculer entre Ollama et le modèle embarqué selon la configuration
 * et la disponibilité des services.
 */
import { OllamaClient } from './OllamaClient.js';
import { EmbeddedLLMClient, DEFAULT_EMBEDDED_MODEL } from './EmbeddedLLMClient.js';
export class LLMProviderManager {
    constructor(config) {
        this.embeddedAvailable = false;
        this.activeProvider = null;
        this.initialized = false;
        this.config = config;
        // Initialiser le client Ollama
        this.ollamaClient = new OllamaClient(config.ollamaURL || 'http://127.0.0.1:11434', config.ollamaChatModel, config.ollamaEmbeddingModel, config.embeddingStrategy || 'nomic-fallback');
        // Initialiser le client embarqué (non chargé tant qu'on n'appelle pas initialize)
        this.embeddedClient = new EmbeddedLLMClient();
    }
    /**
     * Initialise le manager et charge le modèle embarqué si disponible
     */
    async initialize() {
        if (this.initialized) {
            return;
        }
        console.log('🔧 [PROVIDER] Initializing LLM Provider Manager...');
        console.log(`   Configured provider: ${this.config.provider}`);
        console.log(`   Embedded model path: ${this.config.embeddedModelPath || 'not set'}`);
        // Initialiser le modèle embarqué si un chemin est fourni
        if (this.config.embeddedModelPath) {
            try {
                const success = await this.embeddedClient.initialize(this.config.embeddedModelPath, this.config.embeddedModelId);
                this.embeddedAvailable = success;
                if (success) {
                    console.log('✅ [PROVIDER] Embedded model loaded successfully');
                }
            }
            catch (error) {
                console.warn('⚠️ [PROVIDER] Could not load embedded model:', error);
                this.embeddedAvailable = false;
            }
        }
        this.initialized = true;
        // Déterminer le provider actif initial
        await this.getActiveProvider();
        console.log(`✅ [PROVIDER] Initialized. Active provider: ${this.activeProvider || 'none'}`);
    }
    /**
     * Détermine quel provider utiliser selon la config et la disponibilité
     */
    async getActiveProvider() {
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
    async getStatus() {
        const ollamaAvailable = await this.ollamaClient.isAvailable();
        return {
            activeProvider: this.activeProvider,
            ollamaAvailable,
            embeddedAvailable: this.embeddedAvailable,
            embeddedModelId: this.embeddedClient.getModelId(),
            ollamaModel: this.ollamaClient.chatModel,
        };
    }
    /**
     * Retourne le nom lisible du provider actif (pour affichage UI)
     */
    getActiveProviderName() {
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
    getActiveModelName() {
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
    async *generateWithSources(prompt, sources, projectContext, options) {
        const provider = await this.getActiveProvider();
        if (!provider) {
            throw new Error('Aucun provider LLM disponible.\n\n' +
                'Options:\n' +
                '1. Installez et démarrez Ollama (https://ollama.ai)\n' +
                '2. Téléchargez le modèle embarqué dans Paramètres → LLM');
        }
        console.log(`🤖 [PROVIDER] Generating with: ${provider}`);
        if (provider === 'ollama') {
            yield* this.ollamaClient.generateResponseStreamWithSources(prompt, sources, projectContext, options?.model, options?.timeout, options?.generationOptions, options?.systemPrompt);
        }
        else {
            yield* this.embeddedClient.generateResponseStreamWithSources(prompt, sources, projectContext, options?.systemPrompt);
        }
    }
    /**
     * Génère une réponse sans sources (contexte simple)
     */
    async *generateWithoutSources(prompt, context, options) {
        const provider = await this.getActiveProvider();
        if (!provider) {
            throw new Error('Aucun provider LLM disponible.');
        }
        console.log(`🤖 [PROVIDER] Generating (no sources) with: ${provider}`);
        if (provider === 'ollama') {
            yield* this.ollamaClient.generateResponseStream(prompt, context, options?.model, options?.timeout, options?.generationOptions, options?.systemPrompt);
        }
        else {
            yield* this.embeddedClient.generateResponseStream(prompt, context, options?.systemPrompt);
        }
    }
    /**
     * Génère un embedding (toujours via Ollama)
     * IMPORTANT: Le modèle embarqué Qwen n'est PAS un modèle d'embeddings.
     * Les embeddings nécessitent Ollama avec nomic-embed-text ou similaire.
     */
    async generateEmbedding(text) {
        const ollamaAvailable = await this.ollamaClient.isAvailable();
        if (!ollamaAvailable) {
            throw new Error('Ollama est requis pour générer des embeddings.\n' +
                'Le modèle embarqué ne supporte que la génération de texte.\n\n' +
                'Installez et démarrez Ollama: https://ollama.ai');
        }
        return this.ollamaClient.generateEmbedding(text);
    }
    /**
     * Vérifie si les embeddings sont disponibles (Ollama requis)
     */
    async isEmbeddingAvailable() {
        return this.ollamaClient.isAvailable();
    }
    /**
     * Vérifie si Ollama est disponible
     */
    async isOllamaAvailable() {
        return this.ollamaClient.isAvailable();
    }
    /**
     * Vérifie si le modèle embarqué est disponible
     */
    isEmbeddedAvailable() {
        return this.embeddedAvailable;
    }
    /**
     * Retourne le client Ollama (pour compatibilité avec le code existant)
     */
    getOllamaClient() {
        return this.ollamaClient;
    }
    /**
     * Retourne le client embarqué
     */
    getEmbeddedClient() {
        return this.embeddedClient;
    }
    /**
     * Met à jour la configuration du provider préféré
     */
    setProvider(provider) {
        console.log(`🔧 [PROVIDER] Setting provider preference to: ${provider}`);
        this.config.provider = provider;
        this.activeProvider = null; // Force recalcul au prochain appel
    }
    /**
     * Met à jour le chemin du modèle embarqué et réinitialise
     */
    async setEmbeddedModelPath(path, modelId) {
        console.log(`🔧 [PROVIDER] Setting embedded model path: ${path}`);
        // Libérer l'ancien modèle
        await this.embeddedClient.dispose();
        // Charger le nouveau
        this.config.embeddedModelPath = path;
        this.config.embeddedModelId = modelId;
        const success = await this.embeddedClient.initialize(path, modelId);
        this.embeddedAvailable = success;
        // Recalculer le provider actif
        await this.getActiveProvider();
        return success;
    }
    /**
     * Désactive le modèle embarqué
     */
    async disableEmbedded() {
        await this.embeddedClient.dispose();
        this.embeddedAvailable = false;
        this.config.embeddedModelPath = undefined;
        // Recalculer le provider actif
        await this.getActiveProvider();
    }
    /**
     * Libère toutes les ressources
     */
    async dispose() {
        console.log('🧹 [PROVIDER] Disposing LLM Provider Manager...');
        await this.embeddedClient.dispose();
        this.initialized = false;
        this.activeProvider = null;
    }
    /**
     * Retourne la configuration actuelle
     */
    getConfig() {
        return { ...this.config };
    }
}
