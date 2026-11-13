/**
 * Génération embarquée : le vrai rôle système, un historique structuré, la fenêtre réelle (L08-4).
 *
 * Le client fabriquait une chaîne ChatML complète (`<|im_start|>system …`) et la passait comme
 * texte de l'utilisateur à `LlamaChatSession.prompt()`, qui applique déjà son propre gabarit :
 * node-llama-cpp tokenise ce texte sans jetons spéciaux, si bien que les balises restaient du texte
 * et que le vrai rôle système était le prompt anglais par défaut de node-llama-cpp. Les consignes du
 * mode (« Réponds en français », « cite [N] »), les extraits et l'historique arrivaient en vrac dans
 * la question, et, la fenêtre dépassée, c'est la fin du tout qui était coupée : la question
 * (S05-1-25). Température et top-p du panneau étaient ignorés (0,1 et 0,85 en dur).
 *
 * Les tests passent par le fournisseur, comme l'app : `EmbeddedProvider.chat` → vrai
 * `EmbeddedLLMClient` → double de `node-llama-cpp` (`helpers/fake-node-llama-cpp.ts`), qui refuse
 * comme le vrai des consignes trop longues pour la fenêtre.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLlama, fakeTokenize } from './helpers/fake-node-llama-cpp.js';

vi.mock('node-llama-cpp', async () => (await import('./helpers/fake-node-llama-cpp.js')).fakeNodeLlamaCpp);

import { EmbeddedProvider } from '../providers/embedded.js';
import { EMBEDDED_CONTEXT_SIZE, embeddedInputBudget } from '../context-windows.js';
import type { ChatChunk, ChatMessage, ChatOptions, ProviderStatus } from '../providers/base.js';

/** Un tour complet ; l'état du fournisseur est lu avant sa libération, qui le remet à `stopped`. */
async function run(
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<{ status: ProviderStatus; chunks: ChatChunk[] }> {
  const provider = new EmbeddedProvider({ modelPath: '/modeles/qwen.gguf', modelId: 'qwen2.5-0.5b' });
  const chunks: ChatChunk[] = [];
  for await (const chunk of provider.chat(messages, opts)) chunks.push(chunk);
  const status = provider.getStatus();
  await provider.dispose();
  return { status, chunks };
}

/** `n` mots, donc `n` jetons pour le double. */
const words = (n: number, word = 'consigne'): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');

beforeEach(() => {
  fakeLlama.reset();
});

describe('EmbeddedLLMClient — génération structurée', () => {
  it('les consignes en rôle système, les tours en historique, la question brute, les options du tour', async () => {
    const { chunks } = await run(
      [
        { role: 'system', content: 'Réponds TOUJOURS en français.' },
        { role: 'system', content: '[1] type : bibliographie\nTITRE : Les dockers du Havre' },
        { role: 'user', content: 'Qui était Jules Durand ?' },
        { role: 'assistant', content: 'Le secrétaire du syndicat des charbonniers [1].' },
        { role: 'user', content: 'Pourquoi a-t-il été condamné ?' },
      ],
      { temperature: 0, topP: 0.9 }
    );

    expect(fakeLlama.contextSizes).toEqual([EMBEDDED_CONTEXT_SIZE]);
    expect(fakeLlama.sessions).toHaveLength(1);
    const [session] = fakeLlama.sessions;
    const system = 'Réponds TOUJOURS en français.\n\n[1] type : bibliographie\nTITRE : Les dockers du Havre';
    expect(session.systemPrompt).toBe(system);
    expect(session.history).toEqual([
      { type: 'system', text: system },
      { type: 'user', text: 'Qui était Jules Durand ?' },
      { type: 'model', response: ['Le secrétaire du syndicat des charbonniers [1].'] },
    ]);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].text).toBe('Pourquoi a-t-il été condamné ?');
    expect(JSON.stringify(fakeLlama.sessions)).not.toContain('<|im_start|>');
    expect(session.prompts[0].options).toMatchObject({ temperature: 0, topP: 0.9, maxTokens: EMBEDDED_CONTEXT_SIZE / 4 });

    expect(chunks.map((c) => c.delta).join('')).toBe('Selon [1], la grève éclate en 1910.');
    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop' });
    // La session part avec le tour ; la séquence reste au client pour le suivant.
    expect(session.disposed).toEqual({ disposeSequence: false });
  });

  it('sans consigne, aucun prompt système : ni celui de node-llama-cpp, ni une consigne vide', async () => {
    await run([{ role: 'user', content: 'Bonjour' }]);
    const [session] = fakeLlama.sessions;
    expect(session.history).toEqual([]);
    expect(session.systemPrompt).toBeUndefined();
    expect(session.prompts[0].text).toBe('Bonjour');
  });

  it('une question restée sans réponse rejoint la suivante, comme node-llama-cpp les réunirait', async () => {
    await run([
      { role: 'user', content: 'Première question' },
      { role: 'assistant', content: 'Réponse' },
      { role: 'user', content: 'Question restée sans réponse' },
      { role: 'user', content: 'Nouvelle question' },
    ]);
    const [session] = fakeLlama.sessions;
    expect(session.history).toEqual([
      { type: 'user', text: 'Première question' },
      { type: 'model', response: ['Réponse'] },
    ]);
    expect(session.prompts[0].text).toBe('Question restée sans réponse\n\nNouvelle question');
  });

  it('des consignes de trois fois la fenêtre : la fin est coupée et marquée, la tête et la question restent, sans exception', async () => {
    const head = 'Tu es un spécialiste de l’historiographie. Réponds TOUJOURS en français.';
    const system = `${head} ${words(3 * EMBEDDED_CONTEXT_SIZE)} FIN-DES-CONSIGNES`;
    const question = 'Quelles interprétations de la grève de 1910 ?';

    const { chunks } = await run([
      { role: 'system', content: system },
      { role: 'user', content: question },
    ]);

    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop' });
    const [session] = fakeLlama.sessions;
    const sent = session.systemPrompt ?? '';
    expect(sent.startsWith(head)).toBe(true);
    expect(sent.endsWith('[…]')).toBe(true);
    expect(sent).not.toContain('FIN-DES-CONSIGNES');
    expect(session.history?.[0]).toEqual({ type: 'system', text: sent });
    expect(session.prompts[0].kept).toBe(question);
    expect(fakeTokenize(sent).length + fakeTokenize(question).length).toBeLessThanOrEqual(
      embeddedInputBudget(EMBEDDED_CONTEXT_SIZE)
    );
  });

  // Le résumé du compacteur (L09-9) arrive ici comme une seule question qui contient tout le milieu
  // de la conversation. Plus longue que le budget, elle n'est jamais coupée : refusée avant le moteur,
  // par une erreur lisible que le compacteur traite comme un résumé raté.
  it('une question plus longue que le budget est refusée avant le moteur, par une erreur lisible', async () => {
    const question = words(embeddedInputBudget(EMBEDDED_CONTEXT_SIZE) + 1, 'mot');
    const { status, chunks } = await run([
      { role: 'system', content: 'Réponds en français.' },
      { role: 'user', content: question },
    ]);

    expect(chunks).toEqual([{ delta: '', done: true, finishReason: 'error' }]);
    expect(fakeLlama.sessions.flatMap((s) => s.prompts)).toEqual([]);
    const cause = status.lastError;
    expect(cause?.code).toBe('embedded_prompt_too_long');
    expect(cause?.message).toMatch(/2664 tokens/);
    expect(cause?.message).not.toMatch(/Failed to compress/);
  });

  // Une recette peut demander une réponse plus longue que la fenêtre ne le permet (`maxTokens: 4000`).
  // Le client l'ignorait sur main (2 048 en dur) ; la prendre telle quelle rendait le budget d'entrée
  // négatif, et chaque appel était refusé. Elle est bornée à la moitié de la fenêtre.
  it('une réponse demandée trop longue est bornée à la moitié de la fenêtre, et l’appel part', async () => {
    const { chunks } = await run(
      [
        { role: 'system', content: 'Réponds en français.' },
        { role: 'user', content: 'Écris un plan détaillé.' },
      ],
      { maxTokens: 4000 }
    );
    expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: 'stop' });
    expect(fakeLlama.sessions[0].prompts[0].options.maxTokens).toBe(EMBEDDED_CONTEXT_SIZE / 2);
  });

  it('complete() — le résumé du compacteur — part à température 0', async () => {
    const provider = new EmbeddedProvider({ modelPath: '/modeles/qwen.gguf', modelId: 'qwen2.5-0.5b' });
    await expect(provider.complete('Résume la conversation.', { temperature: 0 })).resolves.toBe(
      'Selon [1], la grève éclate en 1910.'
    );
    await provider.dispose();
    expect(fakeLlama.sessions[0].prompts[0].options.temperature).toBe(0);
  });
});
