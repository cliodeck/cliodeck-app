import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  CLOSED_PORT_URL,
  runEmbeddingProviderContract,
  runLLMProviderContract,
} from './contract.js';
import { GeminiEmbeddingProvider, GeminiProvider } from '../gemini.js';
import { runChatTurn } from '../../../../../src/main/services/chat-engine.js';

runLLMProviderContract(
  'gemini',
  () =>
    new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: 'gemini-2.0-flash',
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
