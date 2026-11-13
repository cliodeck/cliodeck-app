/**
 * `collectCompletion` (L09-7) : la boucle commune des `complete()`. Elle rend le texte et l'usage
 * d'un flux fini, et lève `ProviderCallError` sur un terminal `error` ou `cancelled`, avec la cause
 * lue dans l'état du fournisseur.
 */
import { describe, expect, it } from 'vitest';
import type { ChatChunk, ProviderStatus } from '../base.js';
import { collectCompletion, ProviderCallError } from '../collect.js';

async function* stream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c;
}

const status = (s: ProviderStatus) => ({ getStatus: () => s });

describe('collectCompletion', () => {
  it('rend le texte et l’usage d’un flux fini normalement', async () => {
    const out = await collectCompletion(
      status({ state: 'ready' }),
      stream([
        { delta: 'Jean ' },
        { delta: 'Chiappe.', done: true, finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 2 } },
      ])
    );
    expect(out).toEqual({ text: 'Jean Chiappe.', usage: { promptTokens: 3, completionTokens: 2 } });
  });

  it('une fin par la limite de longueur rend le texte, sans lever', async () => {
    const out = await collectCompletion(
      status({ state: 'ready' }),
      stream([{ delta: 'Début', done: true, finishReason: 'length' }])
    );
    expect(out.text).toBe('Début');
  });

  it('un terminal error lève avec le code et le message de lastError', async () => {
    const p = collectCompletion(
      status({
        state: 'degraded',
        lastError: { code: 'anthropic_http_401', message: 'invalid x-api-key', at: 'now' },
      }),
      stream([{ delta: 'Début ' }, { delta: '', done: true, finishReason: 'error' }])
    );
    await expect(p).rejects.toBeInstanceOf(ProviderCallError);
    await expect(p).rejects.toMatchObject({
      code: 'anthropic_http_401',
      message: 'invalid x-api-key',
      finishReason: 'error',
    });
  });

  it('un terminal error sans cause connue lève quand même, avec un code générique', async () => {
    await expect(
      collectCompletion(status({ state: 'ready' }), stream([{ delta: '', done: true, finishReason: 'error' }]))
    ).rejects.toMatchObject({ code: 'provider_error', finishReason: 'error' });
  });

  // Une erreur de flux sans détail laisse un message vide dans l'état (revue de L09-7) : un appelant
  // de complete() reçoit quand même une cause lisible.
  it('un message vide dans lastError vaut une cause absente', async () => {
    await expect(
      collectCompletion(
        status({
          state: 'degraded',
          lastError: { code: 'anthropic_stream_error', message: '', at: 'now' },
        }),
        stream([{ delta: '', done: true, finishReason: 'error' }])
      )
    ).rejects.toMatchObject({
      code: 'anthropic_stream_error',
      message: 'Le fournisseur a interrompu la réponse sans donner de cause.',
    });
  });

  it('un terminal cancelled lève, sans prendre la cause d’une panne antérieure', async () => {
    await expect(
      collectCompletion(
        status({
          state: 'degraded',
          lastError: { code: 'ollama_http_500', message: 'ancienne panne', at: 'now' },
        }),
        stream([{ delta: 'Début', done: true, finishReason: 'cancelled' }])
      )
    ).rejects.toMatchObject({ code: 'cancelled', finishReason: 'cancelled' });
  });
});
