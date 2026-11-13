/**
 * Le vrai moteur embarqué, sur un vrai GGUF (L08-4) : sauté quand aucun modèle n'est donné.
 *
 *   CLIODECK_TEST_GGUF=/chemin/qwen2.5-0.5b-instruct-q4_k_m.gguf \
 *     npx vitest run backend/core/llm/__tests__/EmbeddedLLMClient.live.test.ts
 *
 * Le petit Qwen 2.5 0,5B suffit, et ce n'est pas le modèle de génération de production : ce test
 * vérifie le chemin, pas la qualité des réponses. Des consignes plus longues que la fenêtre font
 * lever « Failed to compress chat history » à llama.cpp, qui ne coupe jamais la première consigne
 * système : la coupe de `fitSystemToWindow` doit l'empêcher, sur le vrai tokeniseur. Une question
 * plus longue que la fenêtre est refusée avant le moteur.
 *
 * Le modèle est libéré à la fin (A16) : sortir avec un modèle chargé sur Metal plante le processus.
 * Jamais `llama.dispose()`, qui libère le backend de tout le processus.
 */
import { existsSync } from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EmbeddedProvider } from '../providers/embedded.js';
import { EMBEDDED_CONTEXT_SIZE } from '../context-windows.js';
import type { ChatChunk, ChatMessage, ChatOptions, ProviderStatus } from '../providers/base.js';

const GGUF = process.env.CLIODECK_TEST_GGUF;
const available = !!GGUF && existsSync(GGUF);

/** Réponses courtes : le chemin compte, pas la longueur. */
const SHORT: ChatOptions = { temperature: 0, maxTokens: 48 };

const MODE_FR =
  "Tu es un spécialiste de l'historiographie. Réponds TOUJOURS en français, UNIQUEMENT à partir " +
  'des sources numérotées ci-dessous, et cite le numéro de la source [N] pour chaque affirmation.';

const SENTENCE =
  'La grève des dockers du Havre éclate en août 1910, lorsque la Compagnie générale transatlantique ' +
  'impose le travail de nuit sans majoration de salaire, et le syndicat réclame la journée de dix heures. ';

describe.skipIf(!available)('moteur embarqué réel (GGUF donné par CLIODECK_TEST_GGUF)', () => {
  const provider = new EmbeddedProvider({ modelPath: GGUF ?? '', modelId: 'qwen2.5-0.5b' });

  afterAll(async () => {
    await provider.dispose();
  });

  async function ask(messages: ChatMessage[], opts: ChatOptions = SHORT): Promise<{ text: string; last: ChatChunk; status: ProviderStatus }> {
    let text = '';
    let last: ChatChunk = { delta: '' };
    for await (const chunk of provider.chat(messages, opts)) {
      text += chunk.delta;
      last = chunk;
    }
    return { text, last, status: provider.getStatus() };
  }

  it('consignes de trois fois la fenêtre : une réponse, sans « Failed to compress chat history »', async () => {
    const extracts = Array.from({ length: 64 }, (_, i) => `[${i + 1}] EXTRAIT : ${SENTENCE.repeat(4)}`).join('\n');
    const system = `${MODE_FR}\n\n${extracts}`;
    // Bien au-delà de la fenêtre, même à quatre caractères par jeton.
    expect(system.length / 4).toBeGreaterThan(3 * EMBEDDED_CONTEXT_SIZE);

    const { text, last, status } = await ask([
      { role: 'system', content: system },
      { role: 'user', content: 'Pourquoi les dockers du Havre font-ils grève en 1910 ?' },
    ]);

    expect(status.lastError?.message ?? '').not.toMatch(/Failed to compress/);
    expect(last).toMatchObject({ done: true, finishReason: 'stop' });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);

  it('un historique plus long que la fenêtre : les tours anciens s’effacent, la réponse vient', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push({ role: 'user', content: `Question ${i} : ${SENTENCE.repeat(6)}` });
      history.push({ role: 'assistant', content: `Réponse ${i} : ${SENTENCE.repeat(6)}` });
    }
    const { text, last, status } = await ask([
      { role: 'system', content: MODE_FR },
      ...history,
      { role: 'user', content: 'Résume en une phrase.' },
    ]);
    expect(status.lastError?.message ?? '').not.toMatch(/Failed to compress/);
    expect(last).toMatchObject({ done: true, finishReason: 'stop' });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 180_000);

  it('une question plus longue que la fenêtre : refusée avant le moteur, par une erreur lisible', async () => {
    const { last, status } = await ask([{ role: 'user', content: SENTENCE.repeat(200) }]);
    expect(last).toMatchObject({ done: true, finishReason: 'error' });
    expect(status.lastError?.code).toBe('embedded_prompt_too_long');
    expect(status.lastError?.message).not.toMatch(/Failed to compress/);
  }, 180_000);
});
