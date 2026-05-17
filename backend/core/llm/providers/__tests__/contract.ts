/**
 * Generic contract tests for provider implementations (fusion step 1.1).
 *
 * Usage:
 *   runLLMProviderContract('my-provider', () => new MyProvider({...}));
 *   runEmbeddingProviderContract('my-emb', () => new MyEmbedder({...}));
 *
 * A provider's test file opts-in by calling these helpers. The harness is
 * tolerant: tests requiring a live backend are skipped when `healthCheck()`
 * returns a non-`ready` state, instead of failing — so CI stays green without
 * external services. Parity-level assertions belong to 1.2bis (mock-replay).
 */

import { describe, it, expect } from 'vitest';
import type {
  LLMProvider,
  EmbeddingProvider,
  ChatChunk,
} from '../base.js';

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

export function runLLMProviderContract(
  label: string,
  factory: () => LLMProvider
): void {
  describe(`LLMProvider contract — ${label}`, () => {
    it('exposes a stable identity and capabilities', () => {
      const p = factory();
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.capabilities).toBeDefined();
      expect(typeof p.capabilities.chat).toBe('boolean');
    });

    it('exposes a typed status, never a raw boolean', () => {
      const p = factory();
      const s = p.getStatus();
      expect([
        'unconfigured',
        'spawning',
        'handshaking',
        'ready',
        'degraded',
        'failed',
        'stopped',
      ]).toContain(s.state);
    });

    it('healthCheck updates and returns status', async () => {
      const p = factory();
      const s = await p.healthCheck();
      expect(s).toEqual(p.getStatus());
    });

    it('chat yields at least one chunk with done:true (live backend required, else skipped)', async () => {
      const p = factory();
      const s = await p.healthCheck();
      if (s.state !== 'ready') {
        return; // skip softly when backend unavailable
      }
      const chunks = await collect(
        p.chat([{ role: 'user', content: 'Say hi in one word.' }], {
          maxTokens: 8,
        })
      );
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].done).toBe(true);
    });

    it('dispose is idempotent', async () => {
      const p = factory();
      await p.dispose();
      await p.dispose();
    });
  });
}

export function runEmbeddingProviderContract(
  label: string,
  factory: () => EmbeddingProvider
): void {
  describe(`EmbeddingProvider contract — ${label}`, () => {
    it('exposes identity and positive dimension', () => {
      const p = factory();
      expect(p.id).toBeTruthy();
      expect(p.dimension).toBeGreaterThan(0);
      expect(p.model).toBeTruthy();
    });

    it('exposes a typed status', () => {
      const p = factory();
      expect(p.getStatus().state).toBeTruthy();
    });

    it('embed returns vectors of declared dimension (live backend required, else skipped)', async () => {
      const p = factory();
      const s = await p.healthCheck();
      if (s.state !== 'ready') return;
      const out = await p.embed(['hello world', 'bonjour monde']);
      expect(out).toHaveLength(2);
      expect(out[0]).toHaveLength(p.dimension);
      expect(out[1]).toHaveLength(p.dimension);
    });
  });
}
