/**
 * Mistral provider (fusion step 1.2).
 *
 * Mistral's hosted API is OpenAI-compatible, so we specialise the OpenAI-compat
 * classes with the canonical base URL and preserve the Mistral id so the UI /
 * registry can distinguish it. Primary rationale: francophone audience, the
 * plan explicitly singles out Mistral for that reason.
 *
 * If Mistral diverges from OpenAI's schema in the future (e.g. tool use),
 * replace this with a dedicated impl — the contract tests will catch it.
 */

import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
  type OpenAICompatEmbeddingConfig,
  type OpenAICompatProviderConfig,
} from './openai-compatible.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';

export interface MistralProviderConfig
  extends Omit<OpenAICompatProviderConfig, 'baseUrl'> {
  baseUrl?: string;
}

export interface MistralEmbeddingConfig
  extends Omit<OpenAICompatEmbeddingConfig, 'baseUrl'> {
  baseUrl?: string;
}

export class MistralProvider extends OpenAICompatibleProvider {
  readonly id = 'mistral';
  readonly name = 'Mistral';

  constructor(cfg: MistralProviderConfig) {
    super({ ...cfg, baseUrl: cfg.baseUrl ?? MISTRAL_BASE });
  }
}

export class MistralEmbeddingProvider extends OpenAICompatibleEmbeddingProvider {
  readonly id = 'mistral-embedding';
  readonly name = 'Mistral Embeddings';

  constructor(cfg: MistralEmbeddingConfig) {
    super({ ...cfg, baseUrl: cfg.baseUrl ?? MISTRAL_BASE });
  }
}
