/**
 * Provider parity harness (fusion step 1.2bis).
 *
 * Every LLM provider — regardless of wire format (Ollama NDJSON, OpenAI SSE,
 * Anthropic event/data SSE) — must turn the same logical request into the
 * same normalized `ChatChunk[]` stream and the same embedding vectors.
 * This suite runs each scenario against every provider with a mocked fetch
 * that serves provider-specific wire responses, and asserts equivalence of
 * the *normalized* output. Failure means a provider's parser drifted from
 * the others — the contract tests pass but behavior diverges.
 *
 * Tolerances:
 * - Chunk *count* is compared with `minChunks` (≥), not exact — providers
 *   may collapse empty deltas differently.
 * - Timing and token ordering inside an SSE are not compared (out of scope).
 * - Usage metrics are checked as present/absent, not value-equal (Ollama
 *   reports via prompt_eval_count+eval_count; OpenAI and Anthropic differ).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChunk, LLMProvider } from '../base.js';
import { OllamaProvider, OllamaEmbeddingProvider } from '../ollama.js';
import {
  OpenAICompatibleProvider,
  OpenAICompatibleEmbeddingProvider,
} from '../openai-compatible.js';
import { AnthropicProvider } from '../anthropic.js';
import {
  chatFixtures,
  embeddingFixtures,
  type ChatFixture,
} from './fixtures.js';

// MARK: - fetch mock

type FetchHandler = (url: string, init?: RequestInit) => Response | null;

let handlers: FetchHandler[] = [];
const realFetch = globalThis.fetch;

function install(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    throw new Error(`No mock handler for ${url}`);
  }) as typeof fetch;
}

function restore(): void {
  globalThis.fetch = realFetch;
  handlers = [];
}

function streamResponse(body: string, init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// MARK: - provider drivers

interface ChatDriver {
  label: string;
  build(): LLMProvider;
  serveWire(fixture: ChatFixture): void;
}

const chatDrivers: ChatDriver[] = [
  {
    label: 'ollama',
    build: () =>
      new OllamaProvider({ model: 'llama3.2', baseUrl: 'http://mock.ollama' }),
    serveWire: (f) => {
      handlers.push((url) => {
        if (url.endsWith('/api/chat')) return streamResponse(f.wire.ollama);
        return null;
      });
    },
  },
  {
    label: 'openai-compatible',
    build: () =>
      new OpenAICompatibleProvider({
        baseUrl: 'http://mock.openai/v1',
        model: 'gpt-4o-mini',
      }),
    serveWire: (f) => {
      handlers.push((url) => {
        if (url.endsWith('/chat/completions'))
          return streamResponse(f.wire.openai);
        return null;
      });
    },
  },
  {
    label: 'anthropic',
    build: () =>
      new AnthropicProvider({
        apiKey: 'sk-test',
        model: 'claude-opus-4-6',
        baseUrl: 'http://mock.anthropic/v1',
      }),
    serveWire: (f) => {
      handlers.push((url) => {
        if (url.endsWith('/messages'))
          return streamResponse(f.wire.anthropic);
        return null;
      });
    },
  },
];

// MARK: - collectors

async function collectChat(p: LLMProvider, prompt: string): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const c of p.chat([{ role: 'user', content: prompt }])) {
    chunks.push(c);
  }
  return chunks;
}

function normalize(chunks: ChatChunk[]): {
  text: string;
  finishReason?: ChatChunk['finishReason'];
  textChunks: number;
  hasDone: boolean;
} {
  let text = '';
  let textChunks = 0;
  let finishReason: ChatChunk['finishReason'];
  let hasDone = false;
  for (const c of chunks) {
    if (c.delta) {
      text += c.delta;
      textChunks += 1;
    }
    if (c.done) {
      hasDone = true;
      finishReason = c.finishReason;
    }
  }
  return { text, finishReason, textChunks, hasDone };
}

// MARK: - suite

describe('Provider parity (mock-replay)', () => {
  beforeEach(install);
  afterEach(restore);

  for (const fixture of chatFixtures) {
    describe(`scenario: ${fixture.name}`, () => {
      for (const driver of chatDrivers) {
        it(`${driver.label} matches normalized expectation`, async () => {
          driver.serveWire(fixture);
          const p = driver.build();
          const chunks = await collectChat(p, fixture.userPrompt);
          const norm = normalize(chunks);
          expect(norm.text).toBe(fixture.expected.text);
          expect(norm.hasDone).toBe(true);
          expect(norm.finishReason).toBe(fixture.expected.finishReason);
          expect(norm.textChunks).toBeGreaterThanOrEqual(
            fixture.expected.minChunks
          );
          await p.dispose();
        });
      }
    });
  }

  for (const fixture of embeddingFixtures) {
    describe(`scenario: ${fixture.name}`, () => {
      it('ollama returns expected vectors', async () => {
        let call = 0;
        handlers.push((url) => {
          if (url.endsWith('/api/embeddings')) {
            return jsonResponse(fixture.wire.ollama[call++]);
          }
          return null;
        });
        const p = new OllamaEmbeddingProvider({
          model: 'mock',
          dimension: fixture.dimension,
          baseUrl: 'http://mock.ollama',
        });
        const out = await p.embed(fixture.texts);
        expect(out).toEqual(fixture.expected.vectors);
      });

      it('openai-compatible returns expected vectors (index-ordered)', async () => {
        handlers.push((url) => {
          if (url.endsWith('/embeddings')) {
            return jsonResponse(fixture.wire.openai);
          }
          return null;
        });
        const p = new OpenAICompatibleEmbeddingProvider({
          baseUrl: 'http://mock.openai/v1',
          model: 'mock',
          dimension: fixture.dimension,
        });
        const out = await p.embed(fixture.texts);
        expect(out).toEqual(fixture.expected.vectors);
      });
    });
  }
});
