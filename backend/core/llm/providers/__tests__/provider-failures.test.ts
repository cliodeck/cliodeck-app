/**
 * Toute panne d'un fournisseur finit par un chunk terminal `error` et laisse sa cause dans
 * `getStatus().lastError` (L09-7). `chat-engine` lit l'état au moment où ce chunk arrive, puis
 * lâche le flux : une cause posée après le `yield` ne lui parvient jamais, et le chat disait « le
 * fournisseur a interrompu la réponse sans donner de cause » — ou présentait une réponse coupée
 * comme complète (S05-1-2, S05-1-21, S05-1-5).
 *
 * `fetch` est simulé de bout en bout : rien ne part vers Anthropic, OpenAI, Mistral, Gemini ni
 * Ollama. Les corps d'erreur sont ceux que chaque API documente.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatChunk, LLMProvider, ProviderStatus } from '../base.js';
import { AnthropicProvider } from '../anthropic.js';
import { GeminiProvider } from '../gemini.js';
import { MistralProvider } from '../mistral.js';
import { OllamaProvider } from '../ollama.js';
import { OpenAICompatibleProvider } from '../openai-compatible.js';

interface Driver {
  label: string;
  /** Préfixe des codes d'erreur du fournisseur. */
  prefix: string;
  build(): LLMProvider;
  /** Corps d'une réponse HTTP d'erreur, tel que l'API l'écrit. */
  errorBody(message: string): unknown;
  /** Un fragment de réponse « Début », dans le format du fil. */
  delta(text: string): string;
  /** Une erreur envoyée en cours de flux, après des en-têtes 200. */
  streamError(message: string): string;
}

const sse = (obj: unknown, event?: string): string =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;

const drivers: Driver[] = [
  {
    label: 'anthropic',
    prefix: 'anthropic_',
    build: () =>
      new AnthropicProvider({
        apiKey: 'sk-test',
        model: 'claude-sonnet-4-6',
        baseUrl: 'http://mock.anthropic/v1',
      }),
    errorBody: (message) => ({ type: 'error', error: { type: 'authentication_error', message } }),
    delta: (text) =>
      sse(
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        'content_block_delta'
      ),
    streamError: (message) =>
      sse({ type: 'error', error: { type: 'overloaded_error', message } }, 'error'),
  },
  {
    label: 'openai-compatible',
    prefix: 'openai_compat_',
    build: () =>
      new OpenAICompatibleProvider({ baseUrl: 'http://mock.openai/v1', model: 'gpt-4o-mini' }),
    errorBody: (message) => ({
      error: { message, type: 'invalid_request_error', code: 'invalid_api_key' },
    }),
    delta: (text) => sse({ choices: [{ delta: { content: text } }] }),
    streamError: (message) => sse({ error: { message, type: 'server_error' } }),
  },
  {
    label: 'mistral',
    prefix: 'mistral_',
    build: () =>
      new MistralProvider({ apiKey: 'test', model: 'mistral-small', baseUrl: 'http://mock.mistral/v1' }),
    // Mistral répond `{ message, request_id }`, sans objet `error`.
    errorBody: (message) => ({ message, request_id: 'req-1' }),
    delta: (text) => sse({ choices: [{ delta: { content: text } }] }),
    streamError: (message) => sse({ error: { message, type: 'server_error' } }),
  },
  {
    label: 'gemini',
    prefix: 'gemini_',
    build: () =>
      new GeminiProvider({
        apiKey: 'test-key',
        model: 'gemini-2.0-flash',
        baseUrl: 'http://mock.gemini/v1beta',
      }),
    errorBody: (message) => ({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }),
    delta: (text) => sse({ candidates: [{ content: { parts: [{ text }] } }] }),
    streamError: (message) => sse({ error: { code: 500, message, status: 'INTERNAL' } }),
  },
  {
    label: 'ollama',
    prefix: 'ollama_',
    build: () => new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' }),
    errorBody: (message) => ({ error: message }),
    delta: (text) => `${JSON.stringify({ message: { content: text }, done: false })}\n`,
    streamError: (message) => `${JSON.stringify({ error: message })}\n`,
  },
];

/** Un corps servi en un seul morceau, puis fermé. */
function body(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** Un corps qui envoie `first`, puis casse comme une connexion coupée. */
function brokenBody(first: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(first));
        return;
      }
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(stream, { status: 200 });
}

function serve(response: () => Response): void {
  vi.stubGlobal('fetch', async () => response());
}

/**
 * Lit le flux comme `chat-engine` : l'état du fournisseur est lu à l'arrivée du chunk terminal,
 * puis le flux est lâché.
 */
async function untilTerminal(p: LLMProvider): Promise<{
  text: string;
  thinking: string;
  terminal?: ChatChunk;
  status: ProviderStatus;
}> {
  let text = '';
  let thinking = '';
  for await (const chunk of p.chat([{ role: 'user', content: 'Qui était le préfet en 1934 ?' }])) {
    text += chunk.delta;
    thinking += chunk.thinking ?? '';
    if (chunk.done) return { text, thinking, terminal: chunk, status: p.getStatus() };
  }
  return { text, thinking, status: p.getStatus() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(drivers)('$label — une panne a un terminal error et une cause', (d) => {
  it('HTTP 401 : la cause écrite par l’API est dans lastError, au chunk terminal', async () => {
    serve(() => body(JSON.stringify(d.errorBody('invalid x-api-key')), 401));
    const p = d.build();

    const r = await untilTerminal(p);

    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.state).toBe('degraded');
    expect(r.status.lastError?.code).toBe(`${d.prefix}http_401`);
    expect(r.status.lastError?.message).toContain('invalid x-api-key');
  });

  it('erreur envoyée en cours de flux : terminal error, le début reçu est gardé', async () => {
    serve(() => body(d.delta('Début ') + d.streamError('model runner has unexpectedly stopped')));
    const p = d.build();

    const r = await untilTerminal(p);

    expect(r.text).toBe('Début ');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.state).toBe('degraded');
    expect(r.status.lastError?.code).toBe(`${d.prefix}stream_error`);
    expect(r.status.lastError?.message).toContain('model runner has unexpectedly stopped');
  });

  it('connexion coupée en cours de flux : la cause est lisible dès le chunk terminal', async () => {
    serve(() => brokenBody(d.delta('Début ')));
    const p = d.build();

    const r = await untilTerminal(p);

    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError?.code).toBe(`${d.prefix}stream_failed`);
    expect(r.status.lastError?.message).toContain('terminated');
  });

  it('complete() sur un HTTP 500 rejette avec la cause, au lieu de rendre une chaîne vide', async () => {
    serve(() => body(JSON.stringify(d.errorBody('Internal server error')), 500));
    const p = d.build();

    await expect(p.complete('Résume ce texte.')).rejects.toMatchObject({
      name: 'ProviderCallError',
      code: `${d.prefix}http_500`,
      finishReason: 'error',
      message: expect.stringContaining('Internal server error'),
    });
  });

  it('complete() sur une erreur en cours de flux rejette, au lieu de rendre le début comme un tout', async () => {
    serve(() => body(d.delta('Début ') + d.streamError('Overloaded')));
    const p = d.build();

    await expect(p.complete('Résume ce texte.')).rejects.toMatchObject({
      name: 'ProviderCallError',
      code: `${d.prefix}stream_error`,
      message: expect.stringContaining('Overloaded'),
    });
  });
});

describe('Ollama — erreurs NDJSON (S05-1-2)', () => {
  it('un modèle pensant qui tombe : le raisonnement reçu reste, le tour finit en error', async () => {
    serve(() =>
      body(
        [
          { message: { role: 'assistant', content: '', thinking: 'Je cherche le préfet… ' }, done: false },
          { message: { role: 'assistant', content: '', thinking: 'Chiappe ?' }, done: false },
          { error: 'model runner has unexpectedly stopped, this may be due to resource limitations' },
        ]
          .map((l) => JSON.stringify(l) + '\n')
          .join('')
      )
    );
    const p = new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' });

    const r = await untilTerminal(p);

    expect(r.thinking).toBe('Je cherche le préfet… Chiappe ?');
    expect(r.text).toBe('');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError).toMatchObject({
      code: 'ollama_stream_error',
      message: expect.stringContaining('resource limitations'),
    });
  });

  it('un flux fermé sans ligne done finit en error (ollama_stream_incomplete), jamais en stop', async () => {
    serve(() => body(`${JSON.stringify({ message: { content: 'Début ' }, done: false })}\n`));
    const p = new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' });

    const r = await untilTerminal(p);

    expect(r.text).toBe('Début ');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError?.code).toBe('ollama_stream_incomplete');
  });

  it('une dernière ligne sans saut de ligne final est lue', async () => {
    serve(() =>
      body(
        `${JSON.stringify({ message: { content: 'Jean ' }, done: false })}\n` +
          JSON.stringify({ message: { content: 'Chiappe.' }, done: true, done_reason: 'stop' })
      )
    );
    const p = new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' });

    const r = await untilTerminal(p);

    expect(r.text).toBe('Jean Chiappe.');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'stop' });
  });
});

describe('Anthropic — fin de flux (S05-1-21)', () => {
  it('un flux fermé sans stop_reason finit en error (anthropic_stream_incomplete), jamais en stop', async () => {
    serve(() =>
      body(
        sse({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }, 'message_start') +
          sse(
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Début ' } },
            'content_block_delta'
          )
      )
    );
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      baseUrl: 'http://mock.anthropic/v1',
    });

    const r = await untilTerminal(p);

    expect(r.text).toBe('Début ');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError?.code).toBe('anthropic_stream_incomplete');
  });

  it('overloaded_error en cours de flux : le type et le message de l’API forment la cause', async () => {
    serve(() =>
      body(
        sse(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Début ' } },
          'content_block_delta'
        ) + sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error')
      )
    );
    const p = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-6',
      baseUrl: 'http://mock.anthropic/v1',
    });

    const r = await untilTerminal(p);

    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError?.message).toContain('overloaded_error');
    expect(r.status.lastError?.message).toContain('Overloaded');
  });
});

describe('OpenAI-compatible — les serveurs locaux ne sont pas tenus au finish_reason', () => {
  it('témoin : un flux fermé sans finish_reason ni [DONE] reste une fin normale', async () => {
    serve(() => body(sse({ choices: [{ delta: { content: 'Réponse.' } }] })));
    const p = new OpenAICompatibleProvider({ baseUrl: 'http://mock.openai/v1', model: 'local' });

    const r = await untilTerminal(p);

    expect(r.text).toBe('Réponse.');
    expect(r.terminal).toMatchObject({ done: true, finishReason: 'stop' });
  });
});

describe('readProviderError — ce que le chat affiche d’un refus', () => {
  it('masque une clé passée dans l’URL et borne la longueur', async () => {
    const long = `Requête refusée pour https://exemple.invalid/v1?key=AIzaSECRET123&alt=sse ${'x'.repeat(2000)}`;
    serve(() => body(JSON.stringify({ error: { message: long } }), 400));
    const p = new GeminiProvider({
      apiKey: 'AIzaSECRET123',
      model: 'gemini-2.0-flash',
      baseUrl: 'http://mock.gemini/v1beta',
    });

    const r = await untilTerminal(p);

    expect(r.status.lastError?.message).not.toContain('AIzaSECRET123');
    expect(r.status.lastError?.message.length).toBeLessThanOrEqual(501);
  });

  it('un corps qui n’est pas du JSON est rendu tel quel ; un corps vide donne le code HTTP', async () => {
    serve(() => body('Bad Gateway', 502));
    const p1 = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: 'http://mock.anthropic/v1' });
    expect((await untilTerminal(p1)).status.lastError?.message).toBe('Bad Gateway');

    serve(() => body('', 503));
    const p2 = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: 'http://mock.anthropic/v1' });
    expect((await untilTerminal(p2)).status.lastError?.message).toBe('HTTP 503');
  });
});

// Revue de L09-7 : le message d'une erreur de flux sans détail était un repli en français, écrit
// par le main, que le chat affichait tel quel dans toutes les langues. Il reste vide : le renderer
// dit lui-même, dans la langue de l'interface, que la cause manque.
describe('Erreur de flux sans détail : aucun texte du main, la cause reste vide', () => {
  it.each([
    [
      'ollama',
      () => new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' }),
      `${JSON.stringify({ error: '' })}\n`,
    ],
    [
      'anthropic',
      () =>
        new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: 'http://mock.anthropic/v1' }),
      sse({ type: 'error', error: {} }, 'error'),
    ],
    [
      'gemini',
      () => new GeminiProvider({ apiKey: 'test-key', model: 'gemini-2.0-flash', baseUrl: 'http://mock.gemini/v1beta' }),
      sse({ error: { code: 500 } }),
    ],
  ])('%s', async (label, build, streamError) => {
    serve(() => body(streamError));
    const r = await untilTerminal(build());

    expect(r.terminal).toMatchObject({ done: true, finishReason: 'error' });
    expect(r.status.lastError).toMatchObject({ code: `${label}_stream_error`, message: '' });
  });
});
