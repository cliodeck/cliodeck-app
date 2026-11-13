/**
 * Une demande abandonnée n'est pas une panne (J9).
 *
 * « Arrêter » et la fermeture du projet avortent le signal d'un appel. Pour `chat`, un `fetch` qui
 * rejette sur ce signal, avant toute réponse, finissait en terminal `error` et laissait le
 * fournisseur en état `failed` (« This operation was aborted ») : le chat l'aurait affiché comme
 * une panne, et le tour suivant aurait lu un fournisseur en échec (relevé par L09-7). Il finit
 * désormais en `cancelled`, sans toucher à l'état.
 *
 * Pour `embed`, un `abort()` rejette la promesse par une `AbortError` et ferme la requête. Les
 * fournisseurs HTTP le faisaient déjà (témoins) ; le moteur embarqué levait une erreur ordinaire,
 * et rendait le vecteur d'une passe finie après l'abandon.
 *
 * `fetch` est simulé comme le vrai : il ne répond jamais, et rejette avec la raison du signal dès
 * qu'il s'avorte. Rien ne part sur le réseau.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChunk, EmbeddingProvider, LLMProvider } from '../base.js';
import { AnthropicProvider } from '../anthropic.js';
import { EmbeddedEmbeddingProvider, EmbeddedProvider } from '../embedded.js';
import { GeminiEmbeddingProvider, GeminiProvider } from '../gemini.js';
import { MistralEmbeddingProvider, MistralProvider } from '../mistral.js';
import { OllamaEmbeddingProvider, OllamaProvider } from '../ollama.js';
import { OpenAICompatibleEmbeddingProvider, OpenAICompatibleProvider } from '../openai-compatible.js';
import { instrumentEmbedding, instrumentLLM } from '../instrument.js';
import { FallbackEmbeddingProvider, FallbackLLMProvider, resolveEmbeddingProvider } from '../fallback.js';
import { setInferenceSink } from '../../../usage-journal/context.js';
import type { RecordInferenceInput } from '../../../usage-journal/types.js';
import type { EmbeddedLLMClient } from '../../EmbeddedLLMClient.js';

interface SeenRequest {
  url: string;
  signal: AbortSignal | undefined;
}

/** Un `fetch` qui ne répond jamais, comme un Ollama figé ; il rejette quand son signal s'avorte. */
function silentFetch(): SeenRequest[] {
  const seen: SeenRequest[] = [];
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    seen.push({ url: String(input), signal });
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  return seen;
}

/** Le chunk terminal du flux. */
async function terminalOf(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk | undefined> {
  for await (const chunk of stream) {
    if (chunk.done) return chunk;
  }
  return undefined;
}

const QUESTION = [{ role: 'user' as const, content: 'Qui était le préfet de police en 1934 ?' }];

const chatProviders: Array<{ label: string; build(): LLMProvider }> = [
  {
    label: 'anthropic',
    build: () =>
      new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: 'http://mock.anthropic/v1' }),
  },
  {
    label: 'openai-compatible',
    build: () => new OpenAICompatibleProvider({ baseUrl: 'http://mock.openai/v1', model: 'gpt-4o-mini' }),
  },
  {
    label: 'mistral',
    build: () => new MistralProvider({ apiKey: 'test', model: 'mistral-small', baseUrl: 'http://mock.mistral/v1' }),
  },
  {
    label: 'gemini',
    build: () =>
      new GeminiProvider({ apiKey: 'test-key', model: 'gemini-2.0-flash', baseUrl: 'http://mock.gemini/v1beta' }),
  },
  {
    label: 'ollama',
    build: () => new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' }),
  },
];

const embeddingProviders: Array<{ label: string; build(): EmbeddingProvider }> = [
  {
    label: 'ollama',
    build: () => new OllamaEmbeddingProvider({ model: 'nomic-embed-text', dimension: 768, baseUrl: 'http://mock.ollama' }),
  },
  {
    label: 'openai-compatible',
    build: () =>
      new OpenAICompatibleEmbeddingProvider({
        baseUrl: 'http://mock.openai/v1',
        model: 'text-embedding-3-small',
        dimension: 1536,
      }),
  },
  {
    label: 'mistral',
    build: () =>
      new MistralEmbeddingProvider({
        apiKey: 'test',
        model: 'mistral-embed',
        dimension: 1024,
        baseUrl: 'http://mock.mistral/v1',
      }),
  },
  {
    label: 'gemini',
    build: () =>
      new GeminiEmbeddingProvider({
        apiKey: 'test-key',
        model: 'text-embedding-004',
        dimension: 768,
        baseUrl: 'http://mock.gemini/v1beta',
      }),
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(chatProviders)('$label — chat abandonné avant toute réponse', (d) => {
  it('pendant l’attente de la réponse : la requête est fermée, terminal cancelled, état inchangé', async () => {
    const seen = silentFetch();
    const p = d.build();
    const before = p.getStatus();
    const controller = new AbortController();

    const terminal = terminalOf(p.chat(QUESTION, { signal: controller.signal }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    expect(await terminal).toMatchObject({ done: true, finishReason: 'cancelled' });
    expect(seen[0].signal?.aborted).toBe(true);
    expect(p.getStatus()).toEqual(before);
  });

  it('signal déjà abandonné : terminal cancelled, ni failed ni cause', async () => {
    silentFetch();
    const p = d.build();
    const before = p.getStatus();
    const controller = new AbortController();
    controller.abort();

    expect(await terminalOf(p.chat(QUESTION, { signal: controller.signal }))).toMatchObject({
      done: true,
      finishReason: 'cancelled',
    });
    expect(p.getStatus()).toEqual(before);
  });

  it('complete() abandonné rejette en cancelled, pas en panne', async () => {
    silentFetch();
    const p = d.build();
    const controller = new AbortController();
    controller.abort();

    await expect(p.complete('Résume ce texte.', { signal: controller.signal })).rejects.toMatchObject({
      name: 'ProviderCallError',
      finishReason: 'cancelled',
    });
  });
});

describe.each(embeddingProviders)('$label — embed abandonné (témoin : le signal était déjà honoré)', (d) => {
  it('abort() pendant la requête : rejet par une AbortError, la requête est fermée', async () => {
    const seen = silentFetch();
    const controller = new AbortController();

    const embedding = d.build().embed(['La grève des dockers de Nantes'], { signal: controller.signal });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(embedding).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen[0].signal?.aborted).toBe(true);
  });
});

const MODEL_PATH = '/tmp/does-not-need-to-exist.gguf';

/** L'issue d'une promesse, lue sans l'attendre : `pending` tant qu'elle n'est pas réglée. */
function settle(promise: Promise<unknown>): () => unknown {
  let outcome: unknown = 'pending';
  promise.then(
    (value) => (outcome = { value }),
    (error: unknown) => (outcome = { error })
  );
  return () => outcome;
}

/** Un moteur embarqué dont chaque passe attend `finish()` : une passe llama.cpp ne s'interrompt pas. */
function heldEmbeddingClient(): { client: EmbeddedLLMClient; passes: () => number; entered: Promise<void>; finish: () => void } {
  let passes = 0;
  let enter = (): void => undefined;
  let finish = (): void => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const client = {
    async initializeEmbedding() {
      return true;
    },
    getEmbeddingDimensions: () => 4,
    async generateEmbedding() {
      passes += 1;
      enter();
      await finished;
      return new Float32Array([0.1, 0.2, 0.3, 0.4]);
    },
    async dispose() {},
  };
  return { client: client as unknown as EmbeddedLLMClient, passes: () => passes, entered, finish };
}

describe('moteur embarqué — embed abandonné', () => {
  it('abort() pendant une passe : elle va à son terme, puis la promesse rejette par une AbortError, sans vecteur', async () => {
    const held = heldEmbeddingClient();
    const p = new EmbeddedEmbeddingProvider({ modelPath: MODEL_PATH, dimension: 4, client: held.client });
    const controller = new AbortController();

    const outcome = p
      .embed(['La grève des dockers de Nantes'], { signal: controller.signal })
      .then((vectors) => ({ vectors }), (error: unknown) => ({ error }));
    await held.entered;
    controller.abort();
    held.finish();

    expect(await outcome).toMatchObject({ error: { name: 'AbortError' } });
  });

  it('signal déjà abandonné : AbortError, et aucune passe', async () => {
    const held = heldEmbeddingClient();
    const p = new EmbeddedEmbeddingProvider({ modelPath: MODEL_PATH, dimension: 4, client: held.client });
    const controller = new AbortController();
    controller.abort();

    await expect(p.embed(['texte'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(held.passes()).toBe(0);
  });
});

/**
 * Mode « auto » : Ollama d'abord, le moteur embarqué en repli. Avant chaque `embed`, le repli sonde
 * Ollama (`healthCheck`, `/api/tags`), et ce sondage n'a pas de signal au contrat. Ollama dont le
 * serveur ne répond plus, « Arrêter » attendait la fin du sondage : jusqu'à 300 s, le délai d'en-têtes
 * par défaut d'undici. Le sondage lui-même reste ouvert jusqu'à sa réponse ; l'appel, lui, rejette
 * tout de suite, et aucune demande d'embedding ne part.
 */
describe('repli Ollama → moteur embarqué (« auto ») — abandonné pendant le sondage d’Ollama', () => {
  function autoProvider(): { fallback: FallbackEmbeddingProvider; held: ReturnType<typeof heldEmbeddingClient> } {
    const held = heldEmbeddingClient();
    const fallback = new FallbackEmbeddingProvider(
      new OllamaEmbeddingProvider({ model: 'nomic-embed-text', dimension: 4, baseUrl: 'http://mock.ollama' }),
      new EmbeddedEmbeddingProvider({ modelPath: MODEL_PATH, dimension: 4, client: held.client })
    );
    return { fallback, held };
  }

  it.each([
    {
      cas: 'embed',
      call: (p: EmbeddingProvider, signal: AbortSignal) => p.embed(['La grève des dockers de Nantes'], { signal }),
    },
    {
      cas: 'le fournisseur résolu avant l’embedding (clé du cache de la recherche)',
      call: (p: EmbeddingProvider, signal: AbortSignal) => resolveEmbeddingProvider(p, signal),
    },
  ])('$cas : abort() pendant le sondage rejette par une AbortError, sans demande d’embedding', async ({ call }) => {
    const seen = silentFetch();
    const { fallback, held } = autoProvider();
    // Comme dans l'app : le repli arrive enveloppé par le décorateur du journal d'usage.
    const embedder = instrumentEmbedding(fallback, 'ollama', 'http://mock.ollama');
    const controller = new AbortController();

    const outcome = settle(call(embedder, controller.signal));
    await vi.waitFor(() => expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']));
    controller.abort();

    await vi.waitFor(() => expect(outcome()).toMatchObject({ error: { name: 'AbortError' } }), { timeout: 2_000 });
    expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']);
    expect(held.passes()).toBe(0);
  });

  it('signal déjà abandonné : rejet par une AbortError, sans sondage ni demande d’embedding', async () => {
    const seen = silentFetch();
    const { fallback, held } = autoProvider();
    const controller = new AbortController();
    controller.abort();

    const outcome = settle(fallback.embed(['texte'], { signal: controller.signal }));

    await vi.waitFor(() => expect(outcome()).toMatchObject({ error: { name: 'AbortError' } }), { timeout: 2_000 });
    expect(seen).toEqual([]);
    expect(held.passes()).toBe(0);
  });
});

/** Un moteur de génération embarqué qui compte ce qu'on lui demande : chargement et génération. */
function countingChatClient(): { client: EmbeddedLLMClient; calls: () => number } {
  let calls = 0;
  const client = {
    async initialize() {
      calls += 1;
      return true;
    },
    async *generateResponseStream() {
      calls += 1;
      yield 'réponse du moteur embarqué';
    },
    async dispose() {},
  };
  return { client: client as unknown as EmbeddedLLMClient, calls: () => calls };
}

/**
 * Mode « auto » de la génération (`generationProvider: 'auto'` avec un modèle embarqué installé) :
 * Ollama d'abord, le moteur embarqué en repli (`FallbackLLMProvider`). Avant chaque `chat`, le repli
 * sonde Ollama (`/api/tags`), et ce sondage n'a pas de signal au contrat. Ollama dont le serveur ne
 * répond plus, « Arrêter » n'avait aucun terminal avant la réponse du sondage, jusqu'à 300 s : le
 * tour restait au registre des opérations, et la fermeture du projet attendait sa borne de 30 s.
 * Le flux finit désormais en `cancelled` dès l'abandon ; le sondage, lui, va à son terme.
 */
describe('repli Ollama → moteur embarqué de la génération (« auto ») — abandonné pendant le sondage d’Ollama', () => {
  function autoLLM(): { llm: LLMProvider; engine: ReturnType<typeof countingChatClient> } {
    const engine = countingChatClient();
    const fallback = new FallbackLLMProvider(
      new OllamaProvider({ model: 'qwen3:8b', baseUrl: 'http://mock.ollama' }),
      new EmbeddedProvider({ modelPath: MODEL_PATH, client: engine.client })
    );
    // Comme dans l'app : le repli arrive enveloppé par le décorateur du journal d'usage.
    return { llm: instrumentLLM(fallback, 'ollama', 'http://mock.ollama'), engine };
  }

  it('chat : abort() pendant le sondage finit en cancelled sans attendre sa réponse, et rien n’est demandé au modèle', async () => {
    const seen = silentFetch();
    const { llm, engine } = autoLLM();
    const controller = new AbortController();

    const outcome = settle(terminalOf(llm.chat(QUESTION, { signal: controller.signal })));
    await vi.waitFor(() => expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']));
    controller.abort();

    await vi.waitFor(
      () => expect(outcome()).toMatchObject({ value: { done: true, finishReason: 'cancelled' } }),
      { timeout: 2_000 }
    );
    expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']);
    expect(engine.calls()).toBe(0);
  });

  it('complete : abort() pendant le sondage rejette en cancelled, pas en panne', async () => {
    const seen = silentFetch();
    const { llm, engine } = autoLLM();
    const controller = new AbortController();

    const outcome = settle(llm.complete('Résume ce texte.', { signal: controller.signal }));
    await vi.waitFor(() => expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']));
    controller.abort();

    await vi.waitFor(
      () =>
        expect(outcome()).toMatchObject({ error: { name: 'ProviderCallError', finishReason: 'cancelled' } }),
      { timeout: 2_000 }
    );
    expect(seen.map((r) => r.url)).toEqual(['http://mock.ollama/api/tags']);
    expect(engine.calls()).toBe(0);
  });

  it('signal déjà abandonné : terminal cancelled, sans sondage ni demande au modèle', async () => {
    const seen = silentFetch();
    const { llm, engine } = autoLLM();
    const controller = new AbortController();
    controller.abort();

    const outcome = settle(terminalOf(llm.chat(QUESTION, { signal: controller.signal })));

    await vi.waitFor(
      () => expect(outcome()).toMatchObject({ value: { done: true, finishReason: 'cancelled' } }),
      { timeout: 2_000 }
    );
    expect(seen).toEqual([]);
    expect(engine.calls()).toBe(0);
  });
});

describe('journal d’usage : un embedding abandonné est inscrit « cancelled », ni réussi ni en panne (L09-16)', () => {
  let events: RecordInferenceInput[];

  beforeEach(() => {
    events = [];
    setInferenceSink((e) => events.push(e));
  });
  afterEach(() => {
    setInferenceSink(undefined);
  });

  it('moteur embarqué, abandonné pendant sa passe : un événement « cancelled », pas « ok »', async () => {
    const held = heldEmbeddingClient();
    const embedder = instrumentEmbedding(
      new EmbeddedEmbeddingProvider({ modelPath: MODEL_PATH, dimension: 4, client: held.client }),
      'embedded'
    );
    const controller = new AbortController();

    const outcome = embedder.embed(['texte'], { signal: controller.signal }).catch(() => undefined);
    await held.entered;
    controller.abort();
    held.finish();
    await outcome;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'embedding', status: 'cancelled' });
  });

  it('Ollama, abandonné pendant la requête : un événement « cancelled » (témoin)', async () => {
    const seen = silentFetch();
    const embedder = instrumentEmbedding(
      new OllamaEmbeddingProvider({ model: 'nomic-embed-text', dimension: 768, baseUrl: 'http://mock.ollama' }),
      'ollama',
      'http://mock.ollama'
    );
    const controller = new AbortController();

    const outcome = embedder.embed(['texte'], { signal: controller.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await outcome;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'embedding', status: 'cancelled' });
  });
});
