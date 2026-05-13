/**
 * Tests for the `num_ctx` plumbing through OllamaProvider.chat.
 *
 * Local models with 128K/256K windows (gemma3, gemma4, qwen3, llama 3.2+)
 * stay capped at Ollama's hard-coded `num_ctx=2048` default unless the
 * caller explicitly passes a larger value. The provider therefore MUST
 * forward `ChatOptions.numCtx` as `options.num_ctx` in the request body,
 * and MUST omit it when the caller didn't supply one (so unaware call
 * sites keep their existing behaviour).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OllamaProvider } from '../ollama.js';

interface CapturedRequest {
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let captured: CapturedRequest | null = null;

function streamOne(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          JSON.stringify({
            message: { content: 'hi' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 1,
            eval_count: 1,
          }) + '\n'
        )
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

beforeEach(() => {
  captured = null;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = typeof input === 'string' ? input : input.toString();
    captured = {
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return streamOne();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function drain(provider: OllamaProvider, numCtx?: number): Promise<void> {
  for await (const _ of provider.chat([{ role: 'user', content: 'q' }], {
    numCtx,
  })) {
    // discard
  }
}

describe('OllamaProvider.chat — num_ctx forwarding', () => {
  it('sends options.num_ctx when numCtx is set', async () => {
    const p = new OllamaProvider({ model: 'gemma4:26b', baseUrl: 'http://mock' });
    await drain(p, 131_072);
    const body = captured?.body as { options?: Record<string, unknown> };
    expect(body.options?.num_ctx).toBe(131_072);
  });

  it('omits num_ctx when numCtx is undefined (preserves Ollama default)', async () => {
    const p = new OllamaProvider({ model: 'gemma4:26b', baseUrl: 'http://mock' });
    await drain(p, undefined);
    const body = captured?.body as { options?: Record<string, unknown> };
    expect(body.options).toBeDefined();
    expect(body.options && 'num_ctx' in body.options).toBe(false);
  });

  it('omits num_ctx when numCtx is 0 (treat as "use backend default")', async () => {
    const p = new OllamaProvider({ model: 'gemma4:26b', baseUrl: 'http://mock' });
    await drain(p, 0);
    const body = captured?.body as { options?: Record<string, unknown> };
    expect(body.options && 'num_ctx' in body.options).toBe(false);
  });
});
