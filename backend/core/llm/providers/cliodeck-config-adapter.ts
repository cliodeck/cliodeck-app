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
  const embeddingModel = cfg.ollamaEmbeddingModel || 'nomic-embed-text';
  const dimension =
    opts.dimensionOverride ??
    OLLAMA_EMBEDDING_DIMS[embeddingModel.split(':')[0]] ??
    768;

  const embedding = {
    provider: 'ollama' as const,
    model: embeddingModel,
    dimension,
    baseUrl: cfg.ollamaURL,
  };

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

export function createRegistryFromClioDeckConfig(
  cfg: ClioDeckLLMConfig,
  opts: AdapterOptions = {}
): ProviderRegistry {
  return new ProviderRegistry(clioDeckConfigToRegistryConfig(cfg, opts));
}
