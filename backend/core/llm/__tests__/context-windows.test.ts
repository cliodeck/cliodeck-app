/**
 * Tests for context-window lookup (fusion 1.3).
 *
 * Two things to assert: (1) every well-known model the app actively
 * supports resolves to its documented window, and (2) unknown models
 * fall through to the conservative default rather than over-claiming.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  getContextWindow,
} from '../context-windows';

describe('getContextWindow', () => {
  it('falls back to DEFAULT for missing or unknown models', () => {
    expect(getContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow('')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow('totally-fake-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('matches Anthropic Claude 4.x family', () => {
    expect(getContextWindow('claude-opus-4-7')).toBe(200_000);
    expect(getContextWindow('claude-opus-4-7[1m]')).toBe(200_000);
    expect(getContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('matches OpenAI GPT family', () => {
    expect(getContextWindow('gpt-4o-mini')).toBe(128_000);
    expect(getContextWindow('gpt-4o')).toBe(128_000);
    expect(getContextWindow('gpt-4.1')).toBe(1_000_000);
    expect(getContextWindow('gpt-5')).toBe(256_000);
  });

  it('matches Mistral models', () => {
    expect(getContextWindow('mistral-large-latest')).toBe(128_000);
    expect(getContextWindow('mistral-small-latest')).toBe(128_000);
    expect(getContextWindow('mistral-nemo:latest')).toBe(32_000);
    expect(getContextWindow('codestral-latest')).toBe(256_000);
  });

  it('matches Gemini models', () => {
    expect(getContextWindow('gemini-2.0-flash')).toBe(1_000_000);
    expect(getContextWindow('gemini-1.5-pro')).toBe(2_000_000);
    expect(getContextWindow('gemini-1.0-pro')).toBe(32_000);
  });

  it('matches Llama family', () => {
    expect(getContextWindow('llama3.2:1b')).toBe(131_072);
    expect(getContextWindow('llama3.2:3b')).toBe(131_072);
    expect(getContextWindow('llama3.1:8b')).toBe(131_072);
    expect(getContextWindow('llama3.3:70b')).toBe(131_072);
    // Bare llama3 (no minor version) uses the older default
    expect(getContextWindow('llama3:latest')).toBe(8_192);
  });

  it('matches Qwen, Gemma, Phi', () => {
    expect(getContextWindow('qwen2.5:7b')).toBe(32_768);
    expect(getContextWindow('qwen3:32b')).toBe(131_072);
    expect(getContextWindow('gemma2:2b')).toBe(8_192);
    expect(getContextWindow('phi3:mini')).toBe(4_096);
  });

  it('honours an explicit override over the table', () => {
    expect(getContextWindow('llama3.2:1b', 65_536)).toBe(65_536);
    expect(getContextWindow('claude-opus-4-7', 50_000)).toBe(50_000);
    // Zero or negative override is ignored (uses table).
    expect(getContextWindow('llama3.2:1b', 0)).toBe(131_072);
    expect(getContextWindow('llama3.2:1b', -1)).toBe(131_072);
  });

  it('respects most-specific-first ordering', () => {
    // mistral-large should win over the bare mistral fallback.
    expect(getContextWindow('mistral-large-2407')).toBe(128_000);
    // claude-3-5-sonnet should match before the broad claude-3 rule.
    expect(getContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
  });
});
