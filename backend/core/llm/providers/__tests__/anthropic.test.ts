import { describe, it, expect } from 'vitest';
import { runLLMProviderContract } from './contract.js';
import { AnthropicProvider } from '../anthropic.js';

runLLMProviderContract(
  'anthropic',
  () =>
    new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: 'claude-opus-4-6',
    })
);

describe('AnthropicProvider — config', () => {
  it('is unconfigured without API key', () => {
    const p = new AnthropicProvider({ apiKey: '', model: 'claude-opus-4-6' });
    expect(p.getStatus().state).toBe('unconfigured');
    expect(p.getStatus().lastError?.code).toBe('anthropic_no_api_key');
  });
});
