import {
  runLLMProviderContract,
  runEmbeddingProviderContract,
} from './contract.js';
import {
  OpenAICompatibleEmbeddingProvider,
  OpenAICompatibleProvider,
} from '../openai-compatible.js';

// Points at localhost:1 so healthCheck fails fast and live tests self-skip.
runLLMProviderContract(
  'openai-compatible',
  () =>
    new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'gpt-4o-mini',
    })
);

runEmbeddingProviderContract(
  'openai-compatible-embedding',
  () =>
    new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'text-embedding-3-small',
      dimension: 1536,
    })
);
