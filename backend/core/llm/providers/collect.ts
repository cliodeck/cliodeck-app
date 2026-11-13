/**
 * La boucle commune des `complete()` (L09-7).
 *
 * Chaque fournisseur additionnait les `delta` de son propre `chat()` sans regarder le chunk
 * terminal : une panne rendait une chaîne vide, une coupure en cours de flux rendait le début de
 * la réponse comme un tout (S05-1-2). Le contrat de `base.ts` interdit de lever dans `chat()`, pas
 * dans `complete()` : ici, un terminal `error` ou `cancelled` lève, avec la cause que le
 * fournisseur a rangée dans son état.
 */

import type { ChatChunk, LLMProvider } from './base.js';

/** Un appel au fournisseur qui n'a pas abouti. `code` et `message` viennent de `lastError`. */
export class ProviderCallError extends Error {
  readonly code: string;
  readonly finishReason: 'error' | 'cancelled';

  constructor(code: string, message: string, finishReason: 'error' | 'cancelled') {
    super(message);
    this.name = 'ProviderCallError';
    this.code = code;
    this.finishReason = finishReason;
  }
}

/**
 * Consomme un flux de `chat()` et rend le texte et l'usage. Lève `ProviderCallError` sur un
 * terminal `error` (cause lue dans `provider.getStatus()` au moment du chunk) ou `cancelled`.
 * Une fin par la limite de longueur n'est pas une panne : le texte est rendu.
 */
export async function collectCompletion(
  provider: Pick<LLMProvider, 'getStatus'>,
  chunks: AsyncIterable<ChatChunk>
): Promise<{ text: string; usage?: ChatChunk['usage'] }> {
  let text = '';
  let usage: ChatChunk['usage'];
  for await (const chunk of chunks) {
    text += chunk.delta;
    if (chunk.usage) usage = chunk.usage;
    if (!chunk.done) continue;
    if (chunk.finishReason === 'cancelled') {
      throw new ProviderCallError('cancelled', 'Génération annulée.', 'cancelled');
    }
    if (chunk.finishReason === 'error') {
      const cause = provider.getStatus().lastError;
      throw new ProviderCallError(
        cause?.code ?? 'provider_error',
        cause?.message ?? 'Le fournisseur a interrompu la réponse sans donner de cause.',
        'error'
      );
    }
  }
  return { text, usage };
}
