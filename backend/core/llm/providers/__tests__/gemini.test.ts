import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CLOSED_PORT_URL,
  runEmbeddingProviderContract,
  runLLMProviderContract,
} from './contract.js';
import { GeminiEmbeddingProvider, GeminiProvider } from '../gemini.js';
import { DEFAULT_GEMINI_MODEL } from '../cliodeck-config-adapter.js';
import { runChatTurn } from '../../../../../src/main/services/chat-engine.js';

// Avec `GEMINI_API_KEY`, le contrat part vers Google : le modèle par défaut, pour qu'il soit servi.
runLLMProviderContract(
  'gemini',
  () =>
    new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: DEFAULT_GEMINI_MODEL,
    })
);

// Le contrôle de santé des embeddings envoie un vrai `embed`, même sans clé : sans `GEMINI_API_KEY`,
// un port fermé, pour que rien ne parte vers Google (voir `contract.ts`).
runEmbeddingProviderContract(
  'gemini-embedding',
  () =>
    new GeminiEmbeddingProvider({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: 'text-embedding-004',
      dimension: 768,
      baseUrl: process.env.GEMINI_API_KEY ? undefined : CLOSED_PORT_URL,
    })
);

describe('GeminiProvider — config', () => {
  it('is unconfigured without API key', () => {
    const p = new GeminiProvider({ apiKey: '', model: 'gemini-2.0-flash' });
    expect(p.getStatus().state).toBe('unconfigured');
    expect(p.getStatus().lastError?.code).toBe('gemini_no_api_key');
  });
});

/**
 * Un tour resté sans réponse laisse dans l'historique un message assistant vide (S06-1-1), que
 * l'adaptateur rendait en part `{ text: '' }` : Gemini la refuse, HTTP 400 à chaque tour suivant.
 * Le corps est lu sur un `fetch` simulé : rien ne part en ligne.
 */
describe('GeminiProvider — un tour sans réponse ne part pas dans le corps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[user, assistant vide, user] par runChatTurn : aucune part de texte vide dans le corps envoyé', async () => {
    const bodies: Array<{ contents: Array<{ role: string; parts: Array<{ text?: string }> }> }> = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Roger Langeron.' }] }, finishReason: 'STOP' }],
      })}\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      baseUrl: 'http://mock.gemini/v1beta',
    });

    await runChatTurn({
      provider,
      messages: [
        { role: 'user', content: 'Qui était le préfet de police en 1934 ?' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Et en 1936 ?' },
      ],
    });

    expect(bodies).toHaveLength(1);
    const emptyParts = bodies[0].contents
      .flatMap((c) => c.parts)
      .filter((p) => typeof p.text === 'string' && p.text.trim() === '');
    expect(emptyParts).toEqual([]);
    // Deux questions de suite : l'adaptateur les réunit en un seul contenu `user`.
    expect(bodies[0].contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Qui était le préfet de police en 1934 ?' }, { text: 'Et en 1936 ?' }],
      },
    ]);
  });
});

/**
 * Gemini 3 et 4 exigent qu'on leur rende la signature de pensée (`thoughtSignature`) reçue avec le
 * premier `functionCall` de chaque étape du tour, « in the exact part where it was received » ;
 * sinon « Failure to include signatures will result in a 400 error » (page « Thought signatures » de
 * l'API Gemini, lue le 2026-11-13). Le fournisseur ne la lisait pas : avec le modèle par défaut et un
 * serveur MCP démarré, la deuxième requête d'un tour avec outil était refusée.
 *
 * Le corps est lu sur un `fetch` simulé : rien ne part vers Google.
 */
describe('GeminiProvider — signatures de pensée des appels d’outils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Part = {
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
    thoughtSignature?: string;
  };
  type SentBody = { contents: Array<{ role: string; parts: Part[] }> };

  const sse = (parts: Part[]): string =>
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] })}\n\n`;

  /** Rejoue un tour de chat avec un outil ; chaque réponse simulée est servie dans l'ordre. */
  async function turnBodies(replies: Part[][], model = DEFAULT_GEMINI_MODEL): Promise<SentBody[]> {
    const bodies: SentBody[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const parts = replies[bodies.length - 1] ?? [{ text: 'fin' }];
      return new Response(sse(parts), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      model,
      baseUrl: 'http://mock.gemini/v1beta',
    });
    await runChatTurn({
      provider,
      messages: [{ role: 'user', content: 'Qui était le préfet de police en 1934 ?' }],
      tools: [
        {
          name: 'zotero__search',
          description: '[zotero] Recherche dans la bibliothèque',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      toolHandler: { call: async (_name, args) => ({ ok: true, result: { hits: [], q: args.q } }) },
    });
    return bodies;
  }

  it('un appel d’outil : la signature revient sur la part functionCall où elle a été reçue', async () => {
    const bodies = await turnBodies([
      [
        {
          functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } },
          thoughtSignature: 'SIG-A',
        },
      ],
      [{ text: 'Jean Chiappe.' }],
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].contents).toEqual([
      { role: 'user', parts: [{ text: 'Qui était le préfet de police en 1934 ?' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } },
            thoughtSignature: 'SIG-A',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { name: 'zotero__search', response: { hits: [], q: 'Chiappe' } },
          },
        ],
      },
    ]);
  });

  /**
   * Deux étapes de suite : « each function call will have a signature and you must pass all
   * signatures back ». Les identifiants synthétiques repartaient de `gemini-fc-1` à chaque flux :
   * les deux appels portaient le même, et la signature de l'un serait revenue sur l'autre.
   */
  it('deux étapes de suite : chaque signature revient sur son propre appel', async () => {
    const bodies = await turnBodies([
      [{ functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } }, thoughtSignature: 'SIG-A' }],
      [{ functionCall: { name: 'zotero__search', args: { q: 'Langeron' } }, thoughtSignature: 'SIG-B' }],
      [{ text: 'Jean Chiappe, puis Roger Langeron.' }],
    ]);
    expect(bodies).toHaveLength(3);
    const calls = bodies[2].contents
      .flatMap((c) => c.parts)
      .filter((p) => p.functionCall)
      .map((p) => [p.functionCall?.args.q, p.thoughtSignature]);
    expect(calls).toEqual([
      ['Chiappe', 'SIG-A'],
      ['Langeron', 'SIG-B'],
    ]);
    const responses = bodies[2].contents
      .flatMap((c) => c.parts)
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse?.response.q);
    expect(responses).toEqual(['Chiappe', 'Langeron']);
  });

  /**
   * Appels parallèles : « the `thought_signature` is attached only to the first `functionCall`
   * part », et les réponses ne s'intercalent pas entre les appels (« FC1 + signature, FR1, FC2, FR2 »
   * donne une erreur 400).
   */
  it('deux appels parallèles : la signature reste sur le premier, appels puis réponses groupés', async () => {
    const bodies = await turnBodies([
      [
        { functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } }, thoughtSignature: 'SIG-A' },
        { functionCall: { name: 'zotero__search', args: { q: 'Langeron' } } },
      ],
      [{ text: 'Jean Chiappe, puis Roger Langeron.' }],
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].contents.slice(1)).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } }, thoughtSignature: 'SIG-A' },
          { functionCall: { name: 'zotero__search', args: { q: 'Langeron' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'zotero__search', response: { hits: [], q: 'Chiappe' } } },
          { functionResponse: { name: 'zotero__search', response: { hits: [], q: 'Langeron' } } },
        ],
      },
    ]);
  });

  it('un modèle qui n’envoie pas de signature (Gemini 2.5) : aucune signature inventée', async () => {
    const bodies = await turnBodies(
      [[{ functionCall: { name: 'zotero__search', args: { q: 'Chiappe' } } }], [{ text: 'ok' }]],
      'gemini-2.5-flash'
    );
    expect(JSON.stringify(bodies[1])).not.toContain('thoughtSignature');
    expect(JSON.stringify(bodies[1])).not.toContain('skip_thought_signature_validator');
  });
});

/**
 * Les modèles Gemini qui réfléchissent (2.5, 3, 4) comptent leurs jetons de pensée dans
 * `maxOutputTokens` (« including thought tokens »), et à la limite pendant la réflexion rendent
 * « truncated or empty output » avec `MAX_TOKENS` (page « Thinking », lue le 2026-11-13). Une étape
 * de recette à 800 jetons (`revue-zotero.yaml`) sur le modèle par défaut, qui réfléchit à l'effort
 * `medium`, pouvait rendre un texte vide sans erreur. Même règle que pour OpenAI : le budget demandé
 * reste celui du texte visible, la réserve s'y ajoute, dans la limite de sortie du modèle.
 */
describe('GeminiProvider — réserve de réflexion pour un budget de réponse court', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sentGenerationConfig(
    model: string,
    maxTokens: number | undefined
  ): Promise<Record<string, unknown>> {
    const bodies: Array<{ generationConfig: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Résumé.' }] }, finishReason: 'STOP' }],
      })}\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new GeminiProvider({ apiKey: 'test-key', model, baseUrl: 'http://mock.gemini/v1beta' });
    await provider.complete('Résume', { maxTokens });
    expect(bodies).toHaveLength(1);
    return bodies[0].generationConfig;
  }

  for (const model of [
    DEFAULT_GEMINI_MODEL,
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-4-carbon',
    'gemini-2.5-pro',
    'gemini-flash-latest',
  ]) {
    it(`${model}, étape de recette à 800 jetons : le budget visible plus la réserve de réflexion`, async () => {
      const cfg = await sentGenerationConfig(model, 800);
      expect(cfg.maxOutputTokens).toBe(800 + 32_768);
    });
  }

  it('la réserve ne dépasse pas la limite de sortie des modèles (65 536)', async () => {
    const cfg = await sentGenerationConfig(DEFAULT_GEMINI_MODEL, 40_000);
    expect(cfg.maxOutputTokens).toBe(65_536);
  });

  it('sans budget demandé (le chat), rien n’est envoyé', async () => {
    const cfg = await sentGenerationConfig(DEFAULT_GEMINI_MODEL, undefined);
    expect(cfg).not.toHaveProperty('maxOutputTokens');
  });

  // Gemini 2.0 et 1.5 ne réfléchissent pas, et leur sortie s'arrête à 8 192 jetons : le budget part
  // tel quel.
  for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro']) {
    it(`${model} (sans réflexion) : le budget demandé, sans réserve`, async () => {
      const cfg = await sentGenerationConfig(model, 800);
      expect(cfg.maxOutputTokens).toBe(800);
    });
  }
});
