/**
 * Un tour resté sans réponse (annulé avant le premier jeton, en erreur, raisonnement seul) garde sa
 * bulle à l'écran, `content: ''`. Renvoyée au modèle, cette bulle vide faisait échouer en HTTP 400
 * chaque question suivante chez Claude et Gemini, jusqu'à ce qu'on vide la conversation (S06-1-1).
 */
import { describe, it, expect } from 'vitest';
import { toProviderHistory } from '../provider-history';
import type { BrainstormMessage } from '../../../stores/chatStore';

const q0: BrainstormMessage = { id: 'u-0', role: 'user', content: 'Qui était le préfet en 1934 ?' };
const a0: BrainstormMessage = {
  id: 'a-0',
  role: 'assistant',
  content: 'Le préfet était Jean Chiappe.',
  finishReason: 'stop',
};
const q1: BrainstormMessage = { id: 'u-1', role: 'user', content: 'Et en 1936 ?' };

const sent = [
  { role: 'user', content: 'Qui était le préfet en 1934 ?' },
  { role: 'assistant', content: 'Le préfet était Jean Chiappe.' },
];

describe('toProviderHistory — un tour sans réponse ne repart pas au modèle', () => {
  it.each<[string, Partial<BrainstormMessage>]>([
    ['annulé avant le premier jeton', { content: '', finishReason: 'cancelled' }],
    ['raisonnement seul', { content: '', thinking: 'Voyons, la préfecture de police…', finishReason: 'stop' }],
    [
      'local-error (chat.start refusé)',
      { content: '', finishReason: 'error', error: 'chat.startFailed', isError: true },
    ],
    ['encore en attente', { content: '', pending: true }],
    ['espaces seuls', { content: ' \n\t ', finishReason: 'stop' }],
  ])('%s : ni la bulle vide ni sa question', (_label, bubble) => {
    const empty: BrainstormMessage = { id: 'a-1', role: 'assistant', ...bubble } as BrainstormMessage;
    expect(toProviderHistory([q0, a0, q1, empty])).toEqual(sent);
  });

  it('un tour partiel, même annulé ou en erreur, reste avec sa question', () => {
    const partial: BrainstormMessage = {
      id: 'a-1',
      role: 'assistant',
      content: 'En 1936, le préfet',
      finishReason: 'error',
      error: 'HTTP 529',
      isError: true,
    };
    expect(toProviderHistory([q0, a0, q1, partial])).toEqual([
      ...sent,
      { role: 'user', content: 'Et en 1936 ?' },
      { role: 'assistant', content: 'En 1936, le préfet' },
    ]);
  });

  it('ne garde que le rôle et le texte : le raisonnement d’un tour répondu ne part pas', () => {
    const withThinking: BrainstormMessage = { ...a0, thinking: 'Voyons…', sources: [] };
    expect(toProviderHistory([q0, withThinking])).toEqual(sent);
  });
});
