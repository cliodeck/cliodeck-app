/**
 * Adapter: ClioDeck `LLMConfig` (user-level config-manager shape) →
 * fusion `RegistryConfig` (phase 1.3).
 *
 * The user's `LLMConfig.backend` field selects between Ollama, Claude
 * (Anthropic), and OpenAI; this adapter routes each into the typed
 * provider registry so `ProviderRegistry.getLLM()` returns the right
 * implementation. Keeps the legacy bridge (`bridge.ts`) for projects
 * that have an `LLMProviderConfig` (different shape) and adds a parallel
 * path for the user config that's already in production.
 *
 * Embedding dimensions for known Ollama models default to 768
 * (nomic-embed-text); override via the `dimensionOverride` argument.
 *
 * **Modèle embarqué (llama.cpp en processus)** : les réglages
 * `llm.generationProvider` et `llm.embeddingProvider` (`'ollama' | 'embedded'
 * | 'auto'`) sont honorés ici. Ils ne l'étaient plus depuis la suppression de
 * `LLMProviderManager` (commit 6063021, 2026-04-25) : la ligne
 * `const embedding = cloudEmbedding ?? ollamaEmbedding` décidait seule, et
 * choisir « embarqué » dans les réglages n'avait aucun effet. Sémantique
 * reprise de l'ancien gestionnaire : `auto` = Ollama d'abord, repli embarqué
 * s'il est indisponible.
 *
 * Ces réglages ne concernent que le local. Choisir un backend cloud
 * (claude / openai / mistral / gemini) le laisse maître de la génération :
 * l'utilisateur qui a saisi une clé API veut ce modèle-là.
 */

import type { LLMConfig as ClioDeckLLMConfig } from '../../../types/config.js';
import { ProviderRegistry, type RegistryConfig } from './registry.js';

const OLLAMA_EMBEDDING_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

export interface AdapterOptions {
  dimensionOverride?: number;
}

export function clioDeckConfigToRegistryConfig(
  cfg: ClioDeckLLMConfig,
  opts: AdapterOptions = {}
): RegistryConfig {
  const ollamaEmbeddingModel = cfg.ollamaEmbeddingModel || 'nomic-embed-text';
  const ollamaDimension =
    opts.dimensionOverride ??
    OLLAMA_EMBEDDING_DIMS[ollamaEmbeddingModel.split(':')[0]] ??
    768;

  const ollamaEmbedding = {
    provider: 'ollama' as const,
    model: ollamaEmbeddingModel,
    dimension: ollamaDimension,
    baseUrl: cfg.ollamaURL,
    // Only forwarded when the model honours a larger window (e.g. bge-m3);
    // nomic-embed-text ignores it. Overflow is truncated server-side regardless.
    numCtx: cfg.ollamaEmbeddingNumCtx,
  };

  // Cloud-provider embedding fallbacks — only used when `useCloudEmbeddings`
  // is set AND the selected backend is a cloud provider that supports
  // embeddings. Anthropic has no embeddings API and stays on Ollama.
  const cloudEmbedding: RegistryConfig['embedding'] | null =
    cfg.useCloudEmbeddings && cfg.backend === 'gemini' && cfg.geminiAPIKey
      ? {
          provider: 'gemini',
          model: 'text-embedding-004',
          dimension: opts.dimensionOverride ?? 768,
          apiKey: cfg.geminiAPIKey,
        }
      : cfg.useCloudEmbeddings && cfg.backend === 'openai' && cfg.openaiAPIKey
        ? {
            provider: 'openai-compatible',
            model: 'text-embedding-3-small',
            dimension: opts.dimensionOverride ?? 1536,
            apiKey: cfg.openaiAPIKey,
            baseUrl: 'https://api.openai.com/v1',
          }
        : cfg.useCloudEmbeddings && cfg.backend === 'mistral' && cfg.mistralAPIKey
          ? {
              provider: 'mistral',
              model: 'mistral-embed',
              dimension: opts.dimensionOverride ?? 1024,
              apiKey: cfg.mistralAPIKey,
            }
          : null;

  // Dimension du modèle d'embedding embarqué (nomic-embed-text-v2 : 768).
  const embeddedEmbedding = cfg.embeddedEmbeddingModelPath
    ? {
        provider: 'embedded' as const,
        model: cfg.embeddedEmbeddingModelId || 'nomic-embed-text-v2',
        dimension: opts.dimensionOverride ?? 768,
        modelPath: cfg.embeddedEmbeddingModelPath,
      }
    : null;

  const embeddedLLM = cfg.embeddedModelPath
    ? {
        provider: 'embedded' as const,
        model: cfg.embeddedModelId || 'embedded',
        modelPath: cfg.embeddedModelPath,
      }
    : null;

  /**
   * Un index vectoriel construit avec un modèle puis interrogé avec un autre
   * est silencieusement faux : on n'assemble le repli que si les dimensions
   * concordent. Sinon, mieux vaut un provider en échec — visible — qu'un
   * corpus dont les résultats sont subtilement aberrants.
   */
  function embeddingWithFallback(): RegistryConfig['embedding'] {
    const choice = cfg.embeddingProvider ?? 'auto';
    if (choice === 'embedded') {
      // Réglage explicite : si le modèle n'est pas téléchargé, on retombe sur
      // Ollama plutôt que de laisser l'indexation sans moteur.
      return embeddedEmbedding ?? ollamaEmbedding;
    }
    if (
      choice === 'auto' &&
      embeddedEmbedding &&
      embeddedEmbedding.dimension === ollamaEmbedding.dimension
    ) {
      return { ...ollamaEmbedding, fallback: embeddedEmbedding };
    }
    return ollamaEmbedding;
  }

  // Un embedding cloud demandé explicitement prime : c'est un choix de
  // l'utilisateur, pas un défaut.
  const embedding = cloudEmbedding ?? embeddingWithFallback();

  function localLLM(): RegistryConfig['llm'] {
    const ollamaLLM = {
      provider: 'ollama' as const,
      model: cfg.ollamaChatModel || 'llama3.2',
      baseUrl: cfg.ollamaURL,
    };
    const choice = cfg.generationProvider ?? 'auto';
    if (choice === 'embedded') return embeddedLLM ?? ollamaLLM;
    if (choice === 'auto' && embeddedLLM) {
      return { ...ollamaLLM, fallback: embeddedLLM };
    }
    return ollamaLLM;
  }

  switch (cfg.backend) {
    case 'claude':
      if (!cfg.claudeAPIKey) {
        throw new Error(
          'Anthropic backend selected but no claudeAPIKey set in config.'
        );
      }
      return {
        llm: {
          provider: 'anthropic',
          model: cfg.claudeModel || 'claude-sonnet-4-6',
          apiKey: cfg.claudeAPIKey,
        },
        embedding,
      };

    case 'openai':
      if (!cfg.openaiAPIKey) {
        throw new Error(
          'OpenAI backend selected but no openaiAPIKey set in config.'
        );
      }
      return {
        llm: {
          provider: 'openai-compatible',
          model: cfg.openaiModel || 'gpt-4o-mini',
          apiKey: cfg.openaiAPIKey,
          baseUrl: 'https://api.openai.com/v1',
        },
        embedding,
      };

    case 'mistral':
      if (!cfg.mistralAPIKey) {
        throw new Error(
          'Mistral backend selected but no mistralAPIKey set in config.'
        );
      }
      return {
        llm: {
          provider: 'mistral',
          model: cfg.mistralModel || 'mistral-large-latest',
          apiKey: cfg.mistralAPIKey,
        },
        embedding,
      };

    case 'gemini':
      if (!cfg.geminiAPIKey) {
        throw new Error(
          'Gemini backend selected but no geminiAPIKey set in config.'
        );
      }
      return {
        llm: {
          provider: 'gemini',
          model: cfg.geminiModel || 'gemini-2.0-flash',
          apiKey: cfg.geminiAPIKey,
        },
        embedding,
      };

    case 'ollama':
    default:
      return { llm: localLLM(), embedding };
  }
}

/**
 * Resolve the *active chat model name* for a given LLMConfig — the value
 * that ends up in `RegistryConfig.llm.model`. Used by `ContextCompactor`
 * wiring (fusion 1.3) to look up the model's window without rebuilding
 * the registry just to read one string. Defaults mirror those in
 * `clioDeckConfigToRegistryConfig`.
 */
export function resolveActiveChatModel(cfg: ClioDeckLLMConfig): string {
  switch (cfg.backend) {
    case 'claude':
      return cfg.claudeModel || 'claude-sonnet-4-6';
    case 'openai':
      return cfg.openaiModel || 'gpt-4o-mini';
    case 'mistral':
      return cfg.mistralModel || 'mistral-large-latest';
    case 'gemini':
      return cfg.geminiModel || 'gemini-2.0-flash';
    case 'ollama':
    default:
      // En `embedded`, le modèle actif est le GGUF chargé : c'est sa fenêtre
      // de contexte que le compacteur doit consulter, pas celle de llama3.2.
      return cfg.generationProvider === 'embedded' && cfg.embeddedModelPath
        ? cfg.embeddedModelId || 'embedded'
        : cfg.ollamaChatModel || 'llama3.2';
  }
}

export function createRegistryFromClioDeckConfig(
  cfg: ClioDeckLLMConfig,
  opts: AdapterOptions = {}
): ProviderRegistry {
  return new ProviderRegistry(clioDeckConfigToRegistryConfig(cfg, opts));
}
