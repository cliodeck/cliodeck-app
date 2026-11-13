import {
  runLLMProviderContract,
  runEmbeddingProviderContract,
  ollamaContractUrl,
} from './contract.js';
import {
  OllamaProvider,
  OllamaEmbeddingProvider,
} from '../ollama.js';

// Un port fermé par défaut : sans `CLIODECK_LIVE_OLLAMA=1`, rien ne part vers l'Ollama de la
// machine (voir `contract.ts`).
runLLMProviderContract(
  'ollama',
  () => new OllamaProvider({ model: 'llama3.2', baseUrl: ollamaContractUrl() })
);

runEmbeddingProviderContract(
  'ollama-embedding',
  () =>
    new OllamaEmbeddingProvider({
      model: 'nomic-embed-text',
      dimension: 768,
      baseUrl: ollamaContractUrl(),
    })
);
