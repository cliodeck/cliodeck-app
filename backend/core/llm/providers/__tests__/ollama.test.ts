import {
  runLLMProviderContract,
  runEmbeddingProviderContract,
} from './contract.js';
import {
  OllamaProvider,
  OllamaEmbeddingProvider,
} from '../ollama.js';

runLLMProviderContract(
  'ollama',
  () => new OllamaProvider({ model: 'llama3.2' })
);

runEmbeddingProviderContract(
  'ollama-embedding',
  () =>
    new OllamaEmbeddingProvider({
      model: 'nomic-embed-text',
      dimension: 768,
    })
);
