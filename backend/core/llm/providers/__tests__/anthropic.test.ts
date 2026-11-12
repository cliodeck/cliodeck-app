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
