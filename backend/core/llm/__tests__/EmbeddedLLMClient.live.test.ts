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
 * Le texte arrive au fil de la génération, et « Arrêter » coupe llama.cpp (L09-10) : le temps entre
 * `abort()` et la fin du tour, et le processeur que le moteur rend, sont mesurés sur le vrai moteur.
 * `CLIODECK_TEST_REPORT` : fichier où écrire ce qui a été mesuré.
 *
 * Le modèle est libéré à la fin (A16) : sortir avec un modèle chargé sur Metal plante le processus.
 * Jamais `llama.dispose()`, qui libère le backend de tout le processus.
 */
import { appendFileSync, existsSync } from 'fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EmbeddedProvider } from '../providers/embedded.js';
import { embeddedTokenizerOf, FallbackLLMProvider } from '../providers/fallback.js';
import { instrumentLLM } from '../providers/instrument.js';
import { fitTextToTokens } from '../EmbeddedLLMClient.js';
import { EMBEDDED_CONTEXT_SIZE } from '../context-windows.js';
import type { ChatChunk, ChatMessage, ChatOptions, LLMProvider, ProviderStatus } from '../providers/base.js';
import { setInferenceSink } from '../../usage-journal/context.js';
import type { RecordInferenceInput } from '../../usage-journal/types.js';

const GGUF = process.env.CLIODECK_TEST_GGUF;
const REPORT = process.env.CLIODECK_TEST_REPORT;
const available = !!GGUF && existsSync(GGUF);

function report(line: string): void {
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
}

/** Le processeur consommé par ce processus (llama.cpp compris), en cœurs, depuis `from`. */
function coresSince(from: { cpu: NodeJS.CpuUsage; at: number }): number {
  const used = process.cpuUsage(from.cpu);
  return (used.user + used.system) / 1000 / (performance.now() - from.at);
}

const cpuNow = (): { cpu: NodeJS.CpuUsage; at: number } => ({ cpu: process.cpuUsage(), at: performance.now() });

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

  // Le tour de chat et les slides mesurent ce qui tiendra avant de l'envoyer (revue de L08-4) : le
  // tokeniseur du vrai modèle doit les atteindre à travers le décorateur du journal d'usage et le
  // repli « auto », et la coupe tenir au jeton près sur un vrai tokeniseur.
  it('le tokeniseur du modèle, à travers le journal d’usage et le repli : la coupe tient au jeton près', async () => {
    const deadOllama = {
      id: 'ollama', name: 'Ollama', model: 'llama3.2',
      capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
      getStatus: () => ({ state: 'failed' }),
      healthCheck: async () => ({ state: 'failed' }),
      chat: () => { throw new Error('Ollama arrêté'); },
      complete: async () => '',
      dispose: async () => undefined,
    } as unknown as LLMProvider;
    const wrapped = instrumentLLM(new FallbackLLMProvider(deadOllama, provider), 'ollama', 'http://127.0.0.1:9');
    const tokenizer = await embeddedTokenizerOf(wrapped);
    expect(tokenizer).not.toBeNull();
    if (!tokenizer) return;
    const text = SENTENCE.repeat(40);
    expect(tokenizer.tokenize(text).length).toBeGreaterThan(200);
    const cut = fitTextToTokens(text, 200, tokenizer);
    expect(tokenizer.tokenize(cut).length).toBeLessThanOrEqual(200);
    expect(cut.startsWith('La grève des dockers du Havre')).toBe(true);
    expect(cut.endsWith('[…]')).toBe(true);
    // Ollama présent : aucun tokeniseur, rien n'est mesuré ni coupé.
    expect(await embeddedTokenizerOf(instrumentLLM(deadOllama, 'ollama', 'http://127.0.0.1:9'))).toBeNull();
  }, 180_000);

  /**
   * Une demande qui fait écrire le modèle longtemps, bien plus que ce que les tests lisent avant
   * d'arrêter. Une demande d'histoire longue ne suffit pas : le petit Qwen répond en une vingtaine
   * de morceaux (mesuré). Une énumération, si.
   */
  const LONG_ANSWER: ChatMessage[] = [
    { role: 'system', content: 'Réponds en français.' },
    { role: 'user', content: 'Écris les nombres de 1 à 500 en toutes lettres, un par ligne, sans rien d’autre.' },
  ];

  // Avant le correctif, le client attendait la fin de `session.prompt()` pour céder le premier
  // morceau : il arrivait avec le dernier.
  it('un vrai tour : le premier morceau arrive bien avant la fin de la génération', async () => {
    // Le chargement du modèle n'entre pas dans la mesure.
    expect((await provider.healthCheck()).state).toBe('ready');
    const start = performance.now();
    const arrivals: number[] = [];
    let last: ChatChunk = { delta: '' };
    for await (const chunk of provider.chat(LONG_ANSWER, { temperature: 0, maxTokens: 384 })) {
      if (chunk.delta) arrivals.push(performance.now() - start);
      last = chunk;
    }
    const end = performance.now() - start;
    report(
      `premier morceau : ${arrivals[0]?.toFixed(0)} ms ; fin : ${end.toFixed(0)} ms ; ${arrivals.length} morceaux`
    );

    expect(last).toMatchObject({ done: true, finishReason: 'stop' });
    expect(arrivals.length).toBeGreaterThan(100);
    expect(arrivals[0]).toBeLessThan(end / 4);
  }, 180_000);

  it('« Arrêter » au milieu d’une longue réponse : le tour finit en moins de 2 s, le texte reste, et le processeur est rendu', async () => {
    expect((await provider.healthCheck()).state).toBe('ready');
    const events: RecordInferenceInput[] = [];
    setInferenceSink((e) => events.push(e));
    try {
      // Comme dans l'app : le fournisseur derrière le décorateur du journal d'usage.
      const llm = instrumentLLM(provider, 'embedded');
      const controller = new AbortController();
      let text = '';
      let pieces = 0;
      let writingFrom = cpuNow();
      let writingCores = 0;
      const startedAt = performance.now();
      let firstAt = 0;
      let abortedAt = 0;
      let last: ChatChunk = { delta: '' };
      for await (const chunk of llm.chat(LONG_ANSWER, { temperature: 0, signal: controller.signal })) {
        text += chunk.delta;
        last = chunk;
        if (!chunk.delta) continue;
        pieces += 1;
        if (pieces === 1) firstAt = performance.now();
        if (pieces === 10) writingFrom = cpuNow();
        if (pieces === 80) {
          writingCores = coresSince(writingFrom);
          abortedAt = performance.now();
          controller.abort();
        }
      }
      const stopMs = performance.now() - abortedAt;
      // Une seconde de mesure, une fois le tour fini : ce que le processus consomme encore.
      const idleFrom = cpuNow();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const idleCores = coresSince(idleFrom);
      report(
        `arrêt : ${stopMs.toFixed(0)} ms entre abort() et la fin du tour ; processeur : ` +
          `${writingCores.toFixed(2)} cœur pendant l’écriture, ${idleCores.toFixed(2)} après ; ` +
          `${pieces} morceaux reçus`
      );

      // « Arrêter » est tombé pendant que le modèle écrivait, pas après la fin de sa réponse : sur le
      // code d'avant, les morceaux arrivaient d'un bloc, et l'arrêt ne coupait plus rien.
      expect(abortedAt - firstAt).toBeGreaterThan((abortedAt - startedAt) / 2);
      expect(last).toEqual({ delta: '', done: true, finishReason: 'cancelled' });
      expect(stopMs).toBeLessThan(2000);
      expect(idleCores).toBeLessThan(writingCores / 4);
      expect(pieces).toBeGreaterThanOrEqual(80);
      expect(text.trim().length).toBeGreaterThan(0);
      // Un arrêt n'est pas une panne, et le journal compte ce qui a été produit.
      expect(provider.getStatus()).toMatchObject({ state: 'ready' });
      expect(events.at(-1)).toMatchObject({ provider: 'embedded', status: 'cancelled', completionTokens: Math.ceil(text.length / 4) });

      // La question suivante répond normalement.
      const next = await ask([{ role: 'user', content: 'Qui était Jules Durand ?' }]);
      expect(next.last).toMatchObject({ done: true, finishReason: 'stop' });
      expect(next.text.trim().length).toBeGreaterThan(0);
    } finally {
      setInferenceSink(undefined);
    }
  }, 180_000);

  it('une question plus longue que la fenêtre : refusée avant le moteur, par une erreur lisible', async () => {
    const { last, status } = await ask([{ role: 'user', content: SENTENCE.repeat(200) }]);
    expect(last).toMatchObject({ done: true, finishReason: 'error' });
    expect(status.lastError?.code).toBe('embedded_prompt_too_long');
    expect(status.lastError?.message).not.toMatch(/Failed to compress/);
  }, 180_000);
});
