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
import { Agent } from 'undici';
import { OllamaProvider, ollamaDispatcher } from '../ollama.js';

interface CapturedRequest {
  url: string;
  body: unknown;
  dispatcher?: unknown;
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
      dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher,
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

describe('OllamaProvider.chat — échantillonnage transmis dans options', () => {
  async function drainWith(
    provider: OllamaProvider,
    opts: Parameters<OllamaProvider['chat']>[1]
  ): Promise<void> {
    for await (const _ of provider.chat([{ role: 'user', content: 'q' }], opts)) {
      // discard
    }
  }

  it('envoie repeat_penalty, top_p et top_k quand ils sont fournis', async () => {
    const p = new OllamaProvider({ model: 'qwen3.5:35b', baseUrl: 'http://mock' });
    await drainWith(p, { repeatPenalty: 1.1, topP: 0.85, topK: 40, temperature: 0.1 });
    const body = captured?.body as { options?: Record<string, unknown> };
    expect(body.options).toMatchObject({
      repeat_penalty: 1.1,
      top_p: 0.85,
      top_k: 40,
      temperature: 0.1,
    });
  });

  it('omet repeat_penalty quand il n’est pas fourni (défaut du Modelfile)', async () => {
    const p = new OllamaProvider({ model: 'qwen3.5:35b', baseUrl: 'http://mock' });
    await drainWith(p, {});
    const body = captured?.body as { options?: Record<string, unknown> };
    // `undefined` disparaît à la sérialisation JSON : la clé est absente.
    expect(body.options && 'repeat_penalty' in body.options).toBe(false);
  });
});

describe('OllamaProvider.chat — pas de plafond caché de cinq minutes', () => {
  it('passe au fetch un dispatcher undici sans délai d’en-têtes ni de corps', async () => {
    const p = new OllamaProvider({ model: 'qwen3.5:35b', baseUrl: 'http://mock' });
    await drain(p, 4096);
    // Le `fetch` de Node coupe à 300 s sans dispatcher : un modèle de 22 Go
    // qui charge puis lit 8 000 jetons dépasse ce délai avant le premier jeton.
    expect(captured?.dispatcher).toBeInstanceOf(Agent);
    expect(captured?.dispatcher).toBe(ollamaDispatcher());
  });
});

describe('OllamaProvider.chat — une erreur HTTP a une cause lisible', () => {
  it('lit le `error` JSON d’Ollama et le pose dans le statut du fournisseur', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'model requires more system memory (24.1 GiB) than is available (18.2 GiB)' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const p = new OllamaProvider({ model: 'qwen3.5:35b', baseUrl: 'http://mock' });
    const chunks: Array<{ finishReason?: string }> = [];
    for await (const c of p.chat([{ role: 'user', content: 'q' }])) chunks.push(c);
    expect(chunks.at(-1)?.finishReason).toBe('error');
    const status = p.getStatus();
    expect(status.state).toBe('degraded');
    expect(status.lastError?.code).toBe('ollama_http_500');
    expect(status.lastError?.message).toMatch(/more system memory/);
  });

  it('retombe sur le code HTTP quand le corps n’est pas du JSON', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    const p = new OllamaProvider({ model: 'nope', baseUrl: 'http://mock' });
    for await (const _ of p.chat([{ role: 'user', content: 'q' }])) {
      // discard
    }
    expect(p.getStatus().lastError?.message).toBe('HTTP 404');
  });
});
