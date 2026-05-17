import {
  runLLMProviderContract,
  runEmbeddingProviderContract,
} from './contract.js';
import {
  MistralEmbeddingProvider,
  MistralProvider,
} from '../mistral.js';

runLLMProviderContract(
  'mistral',
  () =>
    new MistralProvider({
      apiKey: process.env.MISTRAL_API_KEY ?? '',
      model: 'mistral-small-latest',
      // override to unreachable host so healthCheck fails fast and live tests skip.
      baseUrl: process.env.MISTRAL_API_KEY
        ? undefined
        : 'http://127.0.0.1:1/v1',
    })
);

runEmbeddingProviderContract(
  'mistral-embedding',
  () =>
    new MistralEmbeddingProvider({
      apiKey: process.env.MISTRAL_API_KEY ?? '',
      model: 'mistral-embed',
      dimension: 1024,
      baseUrl: process.env.MISTRAL_API_KEY
        ? undefined
        : 'http://127.0.0.1:1/v1',
    })
);
