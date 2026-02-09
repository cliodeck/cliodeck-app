import type { SearchResult } from '../../types/pdf-document';
import http from 'http';
import { getSystemPrompt, getDefaultSystemPrompt } from './SystemPrompts.js';

// MARK: - Types

export interface LLMModel {
  id: string;
  name: string;
  size: string;
  description: string;
  recommendedFor: string[];
}

interface OllamaModelsResponse {
  models: Array<{
    name: string;
    size: number;
    digest: string;
    modified_at: string;
  }>;
}

interface OllamaEmbeddingRequest {
  model: string;
  prompt: string;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    seed?: number;
    num_predict?: number;
    num_ctx?: number; // Context window size in tokens
  };
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

// MARK: - Model Context Sizes

/**
 * Known context window sizes for popular Ollama models.
 * Values are in tokens. Default Ollama is usually 2048 or 4096.
 * These are the maximum supported contexts - actual usage depends on available RAM.
 */
export const MODEL_CONTEXT_SIZES: Record<string, { maxContext: number; recommended: number; description: string }> = {
  // Gemma family
  'gemma2:2b': { maxContext: 8192, recommended: 4096, description: 'Google Gemma 2 2B' },
  'gemma2:9b': { maxContext: 8192, recommended: 8192, description: 'Google Gemma 2 9B' },
  'gemma:2b': { maxContext: 8192, recommended: 4096, description: 'Google Gemma 2B' },
  'gemma:7b': { maxContext: 8192, recommended: 8192, description: 'Google Gemma 7B' },

  // Llama 3.2 family (128K context)
  'llama3.2:1b': { maxContext: 131072, recommended: 32768, description: 'Meta Llama 3.2 1B - 128K context' },
  'llama3.2:3b': { maxContext: 131072, recommended: 32768, description: 'Meta Llama 3.2 3B - 128K context' },

  // Llama 3.1 family (128K context)
  'llama3.1:8b': { maxContext: 131072, recommended: 32768, description: 'Meta Llama 3.1 8B - 128K context' },
  'llama3.1:70b': { maxContext: 131072, recommended: 32768, description: 'Meta Llama 3.1 70B - 128K context' },

  // Llama 3 family
  'llama3:8b': { maxContext: 8192, recommended: 8192, description: 'Meta Llama 3 8B' },

  // Mistral family
  'mistral:7b': { maxContext: 32768, recommended: 16384, description: 'Mistral 7B - 32K context' },
  'mistral:7b-instruct': { maxContext: 32768, recommended: 16384, description: 'Mistral 7B Instruct - 32K context' },
  'mistral:7b-instruct-q4_0': { maxContext: 32768, recommended: 16384, description: 'Mistral 7B Instruct Q4 - 32K context' },

  // Ministral family (new Dec 2024+)
  'ministral:3b': { maxContext: 131072, recommended: 32768, description: 'Mistral Ministral 3B - 128K context' },
  'ministral:8b': { maxContext: 131072, recommended: 32768, description: 'Mistral Ministral 8B - 128K context' },

  // Phi family (Microsoft)
  'phi3:mini': { maxContext: 131072, recommended: 16384, description: 'Microsoft Phi-3 Mini - 128K context' },
  'phi3:medium': { maxContext: 131072, recommended: 16384, description: 'Microsoft Phi-3 Medium - 128K context' },
  'phi4:mini': { maxContext: 131072, recommended: 32768, description: 'Microsoft Phi-4 Mini - 128K context' },

  // Qwen family
  'qwen2.5:3b': { maxContext: 32768, recommended: 16384, description: 'Alibaba Qwen 2.5 3B - 32K context' },
  'qwen2.5:7b': { maxContext: 131072, recommended: 32768, description: 'Alibaba Qwen 2.5 7B - 128K context' },

  // SmolLM family (Hugging Face)
  'smollm2:1.7b': { maxContext: 8192, recommended: 4096, description: 'HuggingFace SmolLM2 1.7B' },

  // DeepSeek family
  'deepseek-r1:1.5b': { maxContext: 65536, recommended: 16384, description: 'DeepSeek R1 1.5B - 64K context' },
  'deepseek-r1:7b': { maxContext: 65536, recommended: 32768, description: 'DeepSeek R1 7B - 64K context' },
  'deepseek-r1:8b': { maxContext: 65536, recommended: 32768, description: 'DeepSeek R1 8B - 64K context' },
};

/**
 * Get context size info for a model. Returns default values if model is unknown.
 */
export function getModelContextInfo(modelName: string): { maxContext: number; recommended: number; description: string } {
  // Try exact match first
  if (MODEL_CONTEXT_SIZES[modelName]) {
    return MODEL_CONTEXT_SIZES[modelName];
  }

  // Try to match by base name (e.g., "llama3.2:3b-instruct-q4_0" -> "llama3.2:3b")
  const baseName = modelName.split('-')[0]; // Remove quantization suffix
  if (MODEL_CONTEXT_SIZES[baseName]) {
    return MODEL_CONTEXT_SIZES[baseName];
  }

  // Try to match by family (e.g., "mistral:latest" -> check "mistral:7b")
  const family = modelName.split(':')[0];
  const familyMatch = Object.entries(MODEL_CONTEXT_SIZES).find(([key]) => key.startsWith(family + ':'));
  if (familyMatch) {
    return familyMatch[1];
  }

  // Default conservative values for unknown models
  return {
    maxContext: 4096,
    recommended: 2048,
    description: 'Unknown model - using conservative defaults',
  };
}

// MARK: - Error Classification

/**
 * Classifies Ollama errors and provides user-friendly messages
 */
export interface ClassifiedError {
  type: 'context_overflow' | 'timeout' | 'connection' | 'model_not_found' | 'out_of_memory' | 'unknown';
  userMessage: string;
  technicalDetails: string;
  suggestion: string;
}

export interface ErrorContext {
  model?: string;
  promptLength?: number;
  sourceCount?: number;
  numCtx?: number;
}

export function classifyOllamaError(error: any, context?: ErrorContext): ClassifiedError {
  const message = error?.message || String(error);
  const messageLower = message.toLowerCase();

  // Helper to format context info
  const formatContext = () => {
    const parts: string[] = [];
    if (context?.promptLength) parts.push(`Prompt: ${Math.round(context.promptLength / 1000)}k caractères`);
    if (context?.sourceCount) parts.push(`Sources: ${context.sourceCount}`);
    if (context?.numCtx) parts.push(`Contexte LLM: ${context.numCtx} tokens`);
    if (context?.model) parts.push(`Modèle: ${context.model}`);
    return parts.join(', ');
  };

  // Estimate if the request is "heavy" based on context
  const isHeavyRequest = () => {
    if (!context) return false;
    // Heavy if: many sources, large prompt, or large context window requested
    const largePrompt = (context.promptLength || 0) > 5000;
    const manySources = (context.sourceCount || 0) > 10;
    const largeContext = (context.numCtx || 0) > 16000;
    return largePrompt || manySources || largeContext;
  };

  // Context overflow / prompt too long - explicit errors from Ollama
  if (
    messageLower.includes('context length') ||
    messageLower.includes('maximum context') ||
    messageLower.includes('token limit') ||
    messageLower.includes('too many tokens') ||
    (messageLower.includes('exceeds') && messageLower.includes('context'))
  ) {
    return {
      type: 'context_overflow',
      userMessage: '⚠️ Le contexte est trop long pour le modèle.',
      technicalDetails: formatContext(),
      suggestion: 'Réduisez le nombre de sources (topK) ou utilisez un modèle avec un contexte plus large (ex: llama3.1, mistral).',
    };
  }

  // Timeout
  if (
    messageLower.includes('timeout') ||
    messageLower.includes('timed out') ||
    messageLower.includes('aborterror') ||
    messageLower.includes('aborted')
  ) {
    const suggestion = isHeavyRequest()
      ? 'La requête est trop lourde. Réduisez topK (5-10) ou le contexte LLM, ou augmentez le timeout.'
      : 'Essayez avec une question plus courte, moins de sources, ou augmentez le timeout.';
    return {
      type: 'timeout',
      userMessage: '⏱️ Le modèle a mis trop de temps à répondre.',
      technicalDetails: formatContext(),
      suggestion,
    };
  }

  // Connection errors - ONLY for explicit connection refused
  if (
    messageLower.includes('econnrefused') ||
    messageLower.includes('connection refused')
  ) {
    return {
      type: 'connection',
      userMessage: '🔌 Impossible de se connecter à Ollama.',
      technicalDetails: message,
      suggestion: 'Vérifiez qu\'Ollama est lancé (ollama serve) et accessible sur le port configuré.',
    };
  }

  // Model not found
  if (
    (messageLower.includes('model') && (messageLower.includes('not found') || messageLower.includes('does not exist'))) ||
    (messageLower.includes('pull') && messageLower.includes('first'))
  ) {
    return {
      type: 'model_not_found',
      userMessage: `🔍 Modèle "${context?.model || 'inconnu'}" non trouvé.`,
      technicalDetails: message,
      suggestion: `Téléchargez le modèle avec: ollama pull ${context?.model || 'nom_du_modele'}`,
    };
  }

  // Out of memory - explicit OOM errors
  if (
    messageLower.includes('out of memory') ||
    messageLower.includes('oom') ||
    (messageLower.includes('cuda') && messageLower.includes('memory')) ||
    messageLower.includes('insufficient memory')
  ) {
    return {
      type: 'out_of_memory',
      userMessage: '💾 Mémoire insuffisante pour ce modèle.',
      technicalDetails: formatContext(),
      suggestion: 'Utilisez un modèle plus petit (ex: gemma2:2b, phi3:mini) ou réduisez le contexte LLM.',
    };
  }

  // Fetch failed - IMPORTANT: Check if it's likely a resource issue vs connection issue
  if (messageLower.includes('fetch failed')) {
    // If the request was heavy, it's likely a resource exhaustion, not a connection issue
    if (isHeavyRequest()) {
      const details = formatContext();
      let suggestion = 'La requête est trop lourde pour Ollama. ';

      if ((context?.sourceCount || 0) > 15) {
        suggestion += `Réduisez topK (actuellement ${context?.sourceCount}, essayez 5-10). `;
      }
      if ((context?.numCtx || 0) > 16000) {
        suggestion += `Réduisez le contexte LLM (actuellement ${context?.numCtx}, essayez 8192-16384). `;
      }
      if ((context?.promptLength || 0) > 50000) {
        suggestion += 'Le prompt est très long - moins de sources réduira sa taille.';
      }

      return {
        type: 'context_overflow',
        userMessage: '⚠️ Ollama n\'a pas pu traiter la requête (trop volumineuse).',
        technicalDetails: details || message,
        suggestion: suggestion.trim(),
      };
    }

    // Small request failed - more likely a real connection issue
    return {
      type: 'connection',
      userMessage: '🔌 Erreur de connexion à Ollama.',
      technicalDetails: message,
      suggestion: 'Vérifiez qu\'Ollama est lancé et que le modèle est téléchargé.',
    };
  }

  // Unknown error - but if request was heavy, hint at that
  if (isHeavyRequest()) {
    return {
      type: 'context_overflow',
      userMessage: '⚠️ Erreur lors du traitement - la requête est peut-être trop volumineuse.',
      technicalDetails: formatContext() + ` | Erreur: ${message}`,
      suggestion: 'Essayez avec moins de sources (topK: 5-10) ou un contexte LLM plus petit.',
    };
  }

  return {
    type: 'unknown',
    userMessage: '❌ Une erreur inattendue s\'est produite.',
    technicalDetails: message,
    suggestion: 'Consultez les logs pour plus de détails.',
  };
}

// MARK: - OllamaClient

// Presets de génération pour différents cas d'usage
export const GENERATION_PRESETS = {
  // Pour recherche académique (RECOMMANDÉ pour cohérence)
  academic: {
    temperature: 0.1,      // Quasi-déterministe
    top_p: 0.85,          // Réduit la variance
    top_k: 40,            // Limite les choix
    repeat_penalty: 1.1,  // Évite les répétitions
    seed: 42,             // Reproductible
  },

  // Pour brainstorming/créatif
  creative: {
    temperature: 0.8,
    top_p: 0.95,
    top_k: 80,
    repeat_penalty: 1.0,
  },

  // Déterminisme absolu (debug)
  deterministic: {
    temperature: 0.0,     // Toujours exactement la même réponse
    seed: 12345,
  }
};

export class OllamaClient {
  private baseURL: string;
  public embeddingModel: string = 'nomic-embed-text';
  public chatModel: string = 'gemma2:2b';
  public embeddingStrategy: 'nomic-fallback' | 'mxbai-only' | 'custom' = 'nomic-fallback';

  // Limite de caractères pour nomic-embed-text
  // Modèle supporte 8192 tokens, mais 1 token ≈ 4 chars en moyenne
  // On utilise 2000 chars comme limite sécuritaire pour éviter les erreurs de contexte
  private readonly NOMIC_MAX_LENGTH = 2000;

  constructor(
    baseURL: string = 'http://127.0.0.1:11434',
    chatModel?: string,
    embeddingModel?: string,
    embeddingStrategy?: 'nomic-fallback' | 'mxbai-only' | 'custom'
  ) {
    this.baseURL = baseURL;
    if (chatModel) this.chatModel = chatModel;
    if (embeddingModel) this.embeddingModel = embeddingModel;
    if (embeddingStrategy) this.embeddingStrategy = embeddingStrategy;
  }

  /**
   * Helper method to make HTTP GET requests using Node.js http module
   * More reliable than fetch in Electron main process
   */
  private httpGet(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = http.get(url, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          try {
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              reject(new Error(`HTTP ${response.statusCode}: ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.setTimeout(5000, () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  // MARK: - Vérification disponibilité

  async isAvailable(): Promise<boolean> {
    try {
      await this.listAvailableModels();
      return true;
    } catch {
      return false;
    }
  }

  // MARK: - Liste des modèles disponibles

  async listAvailableModels(): Promise<LLMModel[]> {
    const url = `${this.baseURL}/api/tags`;

    try {
      console.log('🔍 Fetching Ollama models from:', url);
      console.log('   Using Node.js http module (more reliable in Electron)');

      const data = await this.httpGet(url) as OllamaModelsResponse;
      console.log('✅ Successfully fetched', data.models.length, 'models');

      // Convertir les modèles Ollama en LLMModel
      return data.models.map((model) => ({
        id: model.name,
        name: model.name,
        size: this.formatSize(model.size),
        description: 'Modèle Ollama',
        recommendedFor: this.inferRecommendations(model.name),
      }));
    } catch (error: any) {
      console.error('❌ Failed to fetch Ollama models:', error.message);
      console.error('   URL attempted:', url);
      console.error('   Base URL:', this.baseURL);
      throw error;
    }
  }

  // MARK: - Génération d'embeddings

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
        // Look backward up to 200 chars for sentence ending
        const searchStart = Math.max(currentIndex, endIndex - 200);
        const searchText = text.substring(searchStart, endIndex);
        const sentenceEndings = /[.!?;](?=\s|$)/g;
        let lastMatch = null;
        let match;

        while ((match = sentenceEndings.exec(searchText)) !== null) {
          lastMatch = match;
        }

        if (lastMatch) {
          // Cut at last sentence boundary
          endIndex = searchStart + lastMatch.index + 1;
        }
      }

      const chunk = text.substring(currentIndex, endIndex).trim();
      chunks.push(chunk);
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
   * Génère un embedding pour un chunk de texte avec un modèle spécifique
   */
  private async generateEmbeddingWithModel(text: string, model: string): Promise<Float32Array> {
    const url = `${this.baseURL}/api/embeddings`;

    const request: OllamaEmbeddingRequest = {
      model: model,
      prompt: text,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama embedding error: ${response.status} ${response.statusText} - ${errorBody}`
      );
    }

    const data = await response.json() as OllamaEmbeddingResponse;
    return new Float32Array(data.embedding);
  }

  /**
   * Génère un embedding pour un chunk de texte (avec fallback automatique)
   */
  private async generateEmbeddingForChunk(text: string): Promise<Float32Array> {
    // Determine primary model based on strategy
    let primaryModel: string;
    let fallbackModel: string | null = null;

    switch (this.embeddingStrategy) {
      case 'nomic-fallback':
        primaryModel = 'nomic-embed-text';
        fallbackModel = 'mxbai-embed-large';
        break;
      case 'mxbai-only':
        primaryModel = 'mxbai-embed-large';
        fallbackModel = null; // No fallback
        break;
      case 'custom':
        primaryModel = this.embeddingModel;
        fallbackModel = null; // No fallback for custom models
        break;
      default:
        // Default to nomic-fallback for backward compatibility
        primaryModel = this.embeddingModel || 'nomic-embed-text';
        fallbackModel = primaryModel === 'nomic-embed-text' ? 'mxbai-embed-large' : null;
    }

    try {
      // Try primary model
      return await this.generateEmbeddingWithModel(text, primaryModel);
    } catch (error) {
      // Try fallback if available
      if (fallbackModel) {
        console.warn(`⚠️ ${primaryModel} failed, falling back to ${fallbackModel}`);
        console.warn(`   Error: ${error instanceof Error ? error.message : String(error)}`);

        try {
          const result = await this.generateEmbeddingWithModel(text, fallbackModel);
          console.log(`✅ Fallback to ${fallbackModel} successful`);
          return result;
        } catch (fallbackError) {
          console.error(`❌ Fallback to ${fallbackModel} also failed:`, fallbackError);
          throw fallbackError;
        }
      }

      // No fallback available, propagate error
      throw error;
    }
  }

  /**
   * Génère un embedding pour un texte (avec chunking automatique si nécessaire)
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    // Limiter à 2000 caractères par chunk pour tous les modèles d'embedding
    // La plupart des modèles ont des limites de contexte similaires
    const maxLength = this.NOMIC_MAX_LENGTH;

    console.log('📤 Sending Ollama embedding request:', {
      url: `${this.baseURL}/api/embeddings`,
      model: this.embeddingModel,
      textLength: text.length,
      textPreview: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
    });

    // Si le texte est court, traitement normal
    if (text.length <= maxLength) {
      const embedding = await this.generateEmbeddingForChunk(text);
      console.log('✅ Ollama embedding received:', {
        embeddingLength: embedding.length,
      });
      return embedding;
    }

    // Sinon, chunking automatique
    const chunks = this.chunkText(text, maxLength);
    console.log(`⚠️ Text too long (${text.length} chars), splitting into ${chunks.length} chunks`);

    const embeddings: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`   Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const embedding = await this.generateEmbeddingForChunk(chunks[i]);
      embeddings.push(embedding);
    }

    // Moyenner les embeddings
    const averaged = this.averageEmbeddings(embeddings);
    console.log('✅ Ollama embeddings averaged:', {
      chunks: chunks.length,
      embeddingLength: averaged.length,
    });

    return averaged;
  }

  // MARK: - Génération de réponse (non-streaming)

  async generateResponse(prompt: string, context: string[]): Promise<string> {
    const url = `${this.baseURL}/api/generate`;

    const fullPrompt = this.buildPrompt(prompt, context);

    const request: OllamaGenerateRequest = {
      model: this.chatModel,
      prompt: fullPrompt,
      stream: false,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate error: ${response.status}`);
    }

    const data = await response.json() as OllamaGenerateResponse;
    return data.response;
  }

  // MARK: - Génération de réponse (streaming)

  async *generateResponseStream(
    prompt: string,
    context: string[],
    modelOverride?: string,
    timeoutOverride?: number,
    generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & { num_ctx?: number },
    systemPrompt?: string
  ): AsyncGenerator<string> {
    const url = `${this.baseURL}/api/generate`;

    const fullPrompt = this.buildPrompt(prompt, context, systemPrompt);

    const model = modelOverride || this.chatModel;
    const timeout = timeoutOverride || 600000;
    const options = { ...GENERATION_PRESETS.academic, ...generationOptions };

    const request: OllamaGenerateRequest = {
      model,
      prompt: fullPrompt,
      stream: true,
      options,
    };

    console.log('🔍 [OLLAMA DEBUG] Calling Ollama API (no sources):', {
      url,
      model,
      timeout: `${timeout / 1000}s`,
      promptLength: fullPrompt.length,
      contextCount: context.length,
      generationParams: request.options,
    });

    // Error context for classification (no sources in this method)
    const errorContext: ErrorContext = {
      model,
      promptLength: fullPrompt.length,
      sourceCount: context.length, // context strings, not SearchResult
      numCtx: options.num_ctx,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeout),
        // @ts-ignore - undici-specific options
        headersTimeout: timeout, // Wait for headers as long as the main timeout
        bodyTimeout: timeout, // Wait for body chunks as long as the main timeout
      });
    } catch (fetchError: any) {
      // Classify and enhance the error
      const classified = classifyOllamaError(fetchError, errorContext);
      console.error('❌ [OLLAMA] Fetch error classified:', classified);
      const enhancedError = new Error(`${classified.userMessage}\n\n💡 ${classified.suggestion}`);
      (enhancedError as any).classified = classified;
      throw enhancedError;
    }

    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => '');
      console.error('❌ [OLLAMA DEBUG] Ollama API error:', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
        url,
        model
      });
      const classified = classifyOllamaError(
        new Error(`${response.status} ${response.statusText}: ${errorBody}`),
        errorContext
      );
      const enhancedError = new Error(`${classified.userMessage}\n\n💡 ${classified.suggestion}`);
      (enhancedError as any).classified = classified;
      throw enhancedError;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter((l) => l.trim());

        for (const line of lines) {
          try {
            const json: OllamaGenerateResponse = JSON.parse(line);

            if (json.response && json.response.length > 0) {
              yield json.response;
            }

            if (json.done) {
              return;
            }
          } catch (e) {
            // Skip invalid JSON
            console.warn('Invalid JSON chunk:', line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // MARK: - Génération de réponse avec sources (streaming)

  async *generateResponseStreamWithSources(
    prompt: string,
    sources: SearchResult[],
    projectContext?: string,
    modelOverride?: string,
    timeoutOverride?: number,
    generationOptions?: Partial<typeof GENERATION_PRESETS.academic> & { num_ctx?: number },
    systemPrompt?: string
  ): AsyncGenerator<string> {
    const url = `${this.baseURL}/api/generate`;

    const fullPrompt = this.buildPromptWithSources(prompt, sources, projectContext, systemPrompt);

    const model = modelOverride || this.chatModel;
    const timeout = timeoutOverride || 600000;
    const options = { ...GENERATION_PRESETS.academic, ...generationOptions };

    const request: OllamaGenerateRequest = {
      model,
      prompt: fullPrompt,
      stream: true,
      options,
    };

    console.log('🔍 [OLLAMA DEBUG] Calling Ollama API:', {
      url,
      model,
      timeout: `${timeout / 1000}s`,
      promptLength: fullPrompt.length,
      sourceCount: sources.length,
      generationParams: request.options,
    });

    // Error context for classification (with sources)
    const errorContext: ErrorContext = {
      model,
      promptLength: fullPrompt.length,
      sourceCount: sources.length,
      numCtx: options.num_ctx,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeout),
        // @ts-ignore - undici-specific options
        headersTimeout: timeout, // Wait for headers as long as the main timeout
        bodyTimeout: timeout, // Wait for body chunks as long as the main timeout
      });
    } catch (fetchError: any) {
      // Classify and enhance the error
      const classified = classifyOllamaError(fetchError, errorContext);
      console.error('❌ [OLLAMA] Fetch error classified:', classified);
      const enhancedError = new Error(`${classified.userMessage}\n\n💡 ${classified.suggestion}`);
      (enhancedError as any).classified = classified;
      throw enhancedError;
    }

    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => '');
      console.error('❌ [OLLAMA DEBUG] Ollama API error:', {
        status: response.status,
        statusText: response.statusText,
        body: errorBody,
        url,
        model
      });
      const classified = classifyOllamaError(
        new Error(`${response.status} ${response.statusText}: ${errorBody}`),
        errorContext
      );
      const enhancedError = new Error(`${classified.userMessage}\n\n💡 ${classified.suggestion}`);
      (enhancedError as any).classified = classified;
      throw enhancedError;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter((l) => l.trim());

        for (const line of lines) {
          try {
            const json: OllamaGenerateResponse = JSON.parse(line);

            if (json.response && json.response.length > 0) {
              yield json.response;
            }

            if (json.done) {
              return;
            }
          } catch (e) {
            // Skip invalid JSON
            console.warn('Invalid JSON chunk:', line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // MARK: - Construction du prompt avec RAG

  private buildPrompt(userQuery: string, context: string[], systemPrompt?: string): string {
    // Use provided system prompt, or fallback to French default for backwards compatibility
    const systemInstruction = systemPrompt || getDefaultSystemPrompt('fr');

    if (context.length === 0) {
      return userQuery;
    }

    let prompt = `${systemInstruction}

Voici des extraits pertinents des documents :

`;

    context.forEach((chunk, index) => {
      prompt += `\n[Extrait ${index + 1}]\n${chunk}\n`;
    });

    prompt += `\nQuestion de l'utilisateur : ${userQuery}

Réponds de manière précise et académique en te basant sur les extraits fournis. Si les extraits ne contiennent pas l'information nécessaire, dis-le clairement. Cite les numéros des extraits que tu utilises.`;

    return prompt;
  }

  // MARK: - Construction du prompt avec sources complètes

  private buildPromptWithSources(userQuery: string, sources: SearchResult[], projectContext?: string, systemPrompt?: string): string {
    // Use provided system prompt, or fallback to French default for backwards compatibility
    const systemInstruction = systemPrompt || getDefaultSystemPrompt('fr');

    if (sources.length === 0) {
      // Si aucune source ET aucun projet, message d'erreur
      if (!projectContext) {
        return `ERREUR: Aucun projet chargé et aucun document disponible.

Pour utiliser cet assistant, vous devez :
1. Charger un projet (File → Open Project)
2. Indexer des documents PDF dans ce projet

Sans projet ni documents, je ne peux pas vous aider.`;
      }
      // Si projet mais pas de sources
      return userQuery;
    }

    let prompt = `${systemInstruction}
`;

    // 🆕 Ajouter le contexte du projet si disponible
    if (projectContext) {
      prompt += `\nCONTEXTE DU PROJET:
${projectContext}

`;
    }

    prompt += `Voici des extraits pertinents des documents indexés (triés par pertinence décroissante) :

`;

    // Trier les sources par pertinence décroissante
    const sortedSources = [...sources].sort((a, b) => b.similarity - a.similarity);

    // Issue #15: Ne plus afficher les scores de similarité au LLM
    // Les scores peuvent être trompeurs (multilingue, modèles d'embedding différents)
    // Le LLM doit évaluer la pertinence par lui-même basé sur le contenu
    sortedSources.forEach((source, index) => {
      const doc = source.document;
      const chunk = source.chunk;

      // Construire la référence bibliographique
      let reference = '';
      if (doc.author) {
        reference += doc.author;
      } else {
        reference += doc.title;
      }

      if (doc.year) {
        reference += ` (${doc.year})`;
      }

      prompt += `\n[Source ${index + 1} - ${reference}, p. ${chunk.pageNumber}]\n${chunk.content}\n`;
    });

    prompt += `\nQuestion de l'utilisateur : ${userQuery}

IMPORTANT : Réponds de manière précise et académique en te basant sur les extraits fournis.
- Cite TOUJOURS les sources de manière explicite quand tu utilises une information
- Évalue toi-même la pertinence de chaque extrait par rapport à la question

Pour chaque citation, utilise le format complet avec l'auteur (ou titre si pas d'auteur), l'année ET la page. Exemples :
- "Selon Smith (2020, p. 45), la question centrale est..."
- "Cette approche est confirmée par les recherches récentes (Johnson, 2019, p. 12)"
- "Comme le note l'auteur (Database Meets AI, 2021, p. 8)..."

Liste des sources disponibles :`;

    // Ajouter une liste claire des sources à la fin (sans scores)
    sortedSources.forEach((source, index) => {
      const doc = source.document;
      let ref = '';
      if (doc.author) {
        ref = `${doc.author}${doc.year ? ` (${doc.year})` : ''}`;
      } else {
        ref = `${doc.title}${doc.year ? ` (${doc.year})` : ''}`;
      }
      prompt += `\n  - Source ${index + 1}: ${ref}`;
    });

    prompt += `\n\nSi les extraits ne contiennent pas l'information nécessaire pour répondre à la question, dis-le clairement.`;

    return prompt;
  }

  // MARK: - Utilitaires

  private formatSize(bytes: number): string {
    const gb = bytes / 1024 ** 3;
    const mb = bytes / 1024 ** 2;
    return gb >= 1 ? `${gb.toFixed(1)}GB` : `${mb.toFixed(0)}MB`;
  }

  private inferRecommendations(modelName: string): string[] {
    const name = modelName.toLowerCase();
    const recommendations: string[] = [];

    if (name.includes('embed')) {
      recommendations.push('embeddings');
    } else {
      recommendations.push('chat');
    }

    if (
      name.includes('gemma') ||
      name.includes('phi') ||
      name.includes(':2b') ||
      name.includes(':3b')
    ) {
      recommendations.push('cpu');
      recommendations.push('fast');
    }

    if (name.includes('mistral') || name.includes('mixtral')) {
      recommendations.push('french');
    }

    if (name.includes('llama')) {
      recommendations.push('multilingual');
    }

    return recommendations;
  }
}

// MARK: - Modèles recommandés

export const RECOMMENDED_EMBEDDING_MODELS: LLMModel[] = [
  {
    id: 'nomic-embed-text',
    name: 'Nomic Embed Text',
    size: '274M',
    description: 'Excellent modèle d\'embeddings, optimisé CPU, 768 dimensions',
    recommendedFor: ['embeddings', 'cpu', 'english', 'multilingual'],
  },
  {
    id: 'mxbai-embed-large',
    name: 'MixedBread Embed Large',
    size: '335M',
    description: 'Très performant, supporte 512 tokens, 1024 dimensions',
    recommendedFor: ['embeddings', 'cpu', 'long-context'],
  },
];

export const RECOMMENDED_CHAT_MODELS: LLMModel[] = [
  // Petits modèles (CPU standard)
  {
    id: 'gemma2:2b',
    name: 'Gemma 2 2B',
    size: '1.6GB',
    description: 'Très rapide sur CPU, bon pour français, Google',
    recommendedFor: ['chat', 'cpu', 'french', 'fast'],
  },
  {
    id: 'phi3:mini',
    name: 'Phi-3 Mini (3.8B)',
    size: '2.3GB',
    description: 'Excellent rapport qualité/vitesse, Microsoft',
    recommendedFor: ['chat', 'cpu', 'academic', 'fast'],
  },

  // Modèles moyens (CPU puissant)
  {
    id: 'mistral:7b-instruct-q4_0',
    name: 'Mistral 7B Instruct (Q4)',
    size: '4.1GB',
    description: 'Très bon en français, quantized pour CPU',
    recommendedFor: ['chat', 'cpu', 'french', 'quality'],
  },
  {
    id: 'llama3.2:3b',
    name: 'Llama 3.2 3B',
    size: '2GB',
    description: 'Récent et performant, Meta',
    recommendedFor: ['chat', 'cpu', 'multilingual'],
  },

  // Modèles plus gros (CPU très puissant ou GPU)
  {
    id: 'mistral:7b-instruct',
    name: 'Mistral 7B Instruct',
    size: '4.1GB',
    description: 'Version complète, meilleure qualité',
    recommendedFor: ['chat', 'quality', 'french'],
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 8B',
    size: '4.7GB',
    description: 'Très performant, contexte 128k tokens',
    recommendedFor: ['chat', 'quality', 'long-context'],
  },
];
