import { describe, it, expect } from 'vitest';
import {
  runEmbeddingProviderContract,
  runLLMProviderContract,
} from './contract.js';
import { GeminiEmbeddingProvider, GeminiProvider } from '../gemini.js';

runLLMProviderContract(
  'gemini',
  () =>
    new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: 'gemini-2.0-flash',
    })
);

runEmbeddingProviderContract(
  'gemini-embedding',
  () =>
    new GeminiEmbeddingProvider({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: 'text-embedding-004',
      dimension: 768,
    })
);

describe('GeminiProvider — config', () => {
  it('is unconfigured without API key', () => {
    const p = new GeminiProvider({ apiKey: '', model: 'gemini-2.0-flash' });
    expect(p.getStatus().state).toBe('unconfigured');
    expect(p.getStatus().lastError?.code).toBe('gemini_no_api_key');
  });
});
