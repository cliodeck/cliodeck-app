import { afterEach, describe, it, expect, vi } from 'vitest';
import { runLLMProviderContract } from './contract.js';
import { AnthropicProvider } from '../anthropic.js';
import { runChatTurn } from '../../../../../src/main/services/chat-engine.js';

runLLMProviderContract(
  'anthropic',
  () =>
    new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: 'claude-opus-4-6',
    })
);

describe('AnthropicProvider — config', () => {
  it('is unconfigured without API key', () => {
    const p = new AnthropicProvider({ apiKey: '', model: 'claude-opus-4-6' });
    expect(p.getStatus().state).toBe('unconfigured');
    expect(p.getStatus().lastError?.code).toBe('anthropic_no_api_key');
  });
});

/**
 * Le chat n'envoie jamais `maxTokens` : à 1 024 par défaut, toute réponse de Claude s'arrêtait
 * vers 750 mots, sans avertissement (S05-1-7). Le contrôle de santé garde son jeton unique.
 */
describe('AnthropicProvider — max_tokens', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureBodies(): Array<{ max_tokens?: number }> {
    const bodies: Array<{ max_tokens?: number }> = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = [
        'event: message_delta',
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}`,
        '',
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    return bodies;
  }

  const provider = (): AnthropicProvider =>
    new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-sonnet-4-6', baseUrl: 'http://mock.anthropic/v1' });

  it('sans maxTokens, le corps porte max_tokens 8192', async () => {
    const bodies = captureBodies();
    for await (const _ of provider().chat([{ role: 'user', content: 'Synthèse longue.' }])) {
      // le flux est consommé jusqu'au bout
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBe(8192);
  });

  it('un maxTokens explicite est respecté', async () => {
    const bodies = captureBodies();
    for await (const _ of provider().chat([{ role: 'user', content: 'Court.' }], { maxTokens: 300 })) {
      // le flux est consommé jusqu'au bout
    }
    expect(bodies[0].max_tokens).toBe(300);
  });

  it('le contrôle de santé ne demande toujours qu’un jeton', async () => {
    const bodies = captureBodies();
    await provider().healthCheck();
    expect(bodies[0].max_tokens).toBe(1);
  });
});

/**
 * Un tour resté sans réponse laisse dans l'historique un message assistant vide (S06-1-1). L'API
 * Messages refuse tout message non final au contenu vide : HTTP 400 à chaque tour suivant, jusqu'à
 * ce qu'on vide la conversation. Le corps est lu sur un `fetch` simulé : rien ne part en ligne.
 */
describe('AnthropicProvider — un tour sans réponse ne part pas dans le corps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[user, assistant vide, user] par runChatTurn : aucun message vide dans le corps envoyé', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const sse = [
        'event: content_block_delta',
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Roger Langeron.' } })}`,
        '',
        'event: message_delta',
        `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}`,
        '',
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const provider = new AnthropicProvider({
      apiKey: 'sk-test',
      model: 'claude-opus-4-6',
      baseUrl: 'http://mock.anthropic/v1',
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
    const empty = bodies[0].messages.filter(
      (m) => typeof m.content === 'string' && m.content.trim() === ''
    );
    expect(empty).toEqual([]);
    // Deux questions de suite partent telles quelles : l'API Messages les réunit en un tour.
    expect(bodies[0].messages).toEqual([
      { role: 'user', content: 'Qui était le préfet de police en 1934 ?' },
      { role: 'user', content: 'Et en 1936 ?' },
    ]);
  });
});
