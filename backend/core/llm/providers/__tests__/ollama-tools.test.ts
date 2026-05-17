/**
 * Tests for the Ollama tool-use whitelist (fusion 1.8).
 *
 * The whitelist itself is the contract — adding or removing a model is a
 * deliberate decision documented in `docs/research-ollama-tools-1.8.md`,
 * not an accident, so each whitelisted family + each known-bad family
 * gets at least one positive/negative case.
 */
import { describe, it, expect } from 'vitest';
import {
  OllamaProvider,
  isOllamaToolCapableModel,
} from '../ollama.js';

describe('isOllamaToolCapableModel', () => {
  it.each([
    ['ministral-3:8b'],
    ['ministral-3:8b-q4_K_M'],
    ['ministral-3:14b'],
    ['qwen3:8b'],
    ['qwen3:8b-instruct'],
    ['qwen3:14b'],
    ['qwen3:32b'],
    ['mistral-nemo'],
    ['mistral-nemo:latest'],
    ['mistral-nemo:12b'],
  ])('whitelists %s', (model) => {
    expect(isOllamaToolCapableModel(model)).toBe(true);
  });

  it.each([
    // Wrong size — `qwen3:80b` must not pass via `qwen3:8b`.
    ['qwen3:80b'],
    // Smaller variants of whitelisted families — kept off the list because
    // the research flagged them as "decent for size but not very reliable".
    ['ministral-3:3b'],
    ['qwen3:0.6b'],
    ['qwen3:1.7b'],
    ['qwen3:4b'],
    // Llama family — confirmed unreliable across 3.x and 4.x.
    ['llama3.1:8b'],
    ['llama3.2:3b'],
    ['llama3.2'],
    ['llama4:scout'],
    ['llama4:maverick'],
    // Other families with no `tools` badge or known-broken templates.
    ['gemma2:2b'],
    ['phi3:mini'],
    ['mistral:7b'],
    ['mistral-small3.2'],
    // Empty / undefined / unrelated.
    [''],
    ['unknown-model-xyz'],
  ])('does not whitelist %s', (model) => {
    expect(isOllamaToolCapableModel(model)).toBe(false);
  });

  it('handles undefined gracefully (no project loaded)', () => {
    expect(isOllamaToolCapableModel(undefined)).toBe(false);
  });
});

describe('OllamaProvider.capabilities — per-model tools flag', () => {
  it('advertises tools=true when configured with a whitelisted model', () => {
    const p = new OllamaProvider({ model: 'qwen3:8b' });
    expect(p.capabilities.tools).toBe(true);
    expect(p.capabilities.chat).toBe(true);
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.embeddings).toBe(false);
  });

  it('advertises tools=true for ministral-3 sizes the research validated', () => {
    expect(new OllamaProvider({ model: 'ministral-3:8b' }).capabilities.tools).toBe(
      true
    );
    expect(new OllamaProvider({ model: 'ministral-3:14b' }).capabilities.tools).toBe(
      true
    );
  });

  it('advertises tools=false for the legacy llama families the maintainer flagged', () => {
    expect(new OllamaProvider({ model: 'llama3.2' }).capabilities.tools).toBe(false);
    expect(new OllamaProvider({ model: 'llama3.1:8b' }).capabilities.tools).toBe(
      false
    );
    expect(new OllamaProvider({ model: 'llama4:scout' }).capabilities.tools).toBe(
      false
    );
  });

  it('does not pretend tools=true for the smaller ministral-3:3b variant', () => {
    // Composio's own write-up says 3B "isn't very reliable, though decent
    // for the size". Whitelist starts at 8B.
    expect(new OllamaProvider({ model: 'ministral-3:3b' }).capabilities.tools).toBe(
      false
    );
  });
});
