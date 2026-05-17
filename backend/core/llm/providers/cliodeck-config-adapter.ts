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

  const embedding = cloudEmbedding ?? ollamaEmbedding;

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
      return {
        llm: {
          provider: 'ollama',
          model: cfg.ollamaChatModel || 'llama3.2',
          baseUrl: cfg.ollamaURL,
        },
        embedding,
      };
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
      return cfg.ollamaChatModel || 'llama3.2';
  }
}

export function createRegistryFromClioDeckConfig(
  cfg: ClioDeckLLMConfig,
  opts: AdapterOptions = {}
): ProviderRegistry {
  return new ProviderRegistry(clioDeckConfigToRegistryConfig(cfg, opts));
}
