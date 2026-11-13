/**
 * Slides d'un long document par le vrai moteur embarqué (revue de L08-4) : sauté quand aucun modèle
 * n'est donné.
 *
 *   CLIODECK_TEST_GGUF=/chemin/qwen2.5-0.5b-instruct-q4_k_m.gguf \
 *     npx vitest run src/main/services/__tests__/slides-generation-service.live.test.ts
 *
 * Le petit Qwen 2.5 0,5B suffit, et ce n'est pas le modèle de génération de production : ce test
 * vérifie le chemin, pas la qualité des slides. Avant le correctif, un document de 16 000
 * caractères donnait un résultat vide (`embedded_prompt_too_long`, terminal ignoré par le service) ;
 * puis, avec une bibliographie de 50 références de taille courante, le document ne recevait plus
 * aucune place (revue de L08-4). « Arrêter » coupe llama.cpp, et le texte déjà reçu reste (L09-10).
 *
 * `CLIODECK_TEST_REPORT` : fichier où écrire ce qui a été mesuré.
 *
 * Le modèle est libéré à la fin (A16). Jamais `llama.dispose()`.
 */
import { appendFileSync, existsSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ BrowserWindow: {} }));

import { EmbeddedProvider } from '../../../../backend/core/llm/providers/embedded.js';
import { instrumentLLM } from '../../../../backend/core/llm/providers/instrument.js';
import { SlidesGenerationService } from '../slides-generation-service.js';

const GGUF = process.env.CLIODECK_TEST_GGUF;
const REPORT = process.env.CLIODECK_TEST_REPORT;
const available = !!GGUF && existsSync(GGUF);

const SENTENCE =
  'La grève des dockers du Havre éclate en août 1910, lorsque la Compagnie générale transatlantique ' +
  'impose le travail de nuit sans majoration de salaire. ';

const AUTHORS = [
  'Pigenet, Michel',
  'Perrot, Michelle',
  'Noiriel, Gérard et Offerlé, Michel',
  'Cottereau, Alain',
  'Prost, Antoine et Winter, Jay',
];
const TITLES = [
  'Les ouvriers du Cher : travail, espace et conscience sociale',
  'Les ouvriers en grève : France, 1871-1890, la mobilisation',
  'Les ouvriers dans la société française, XIXe-XXe siècle',
  'Le travail et ses représentations dans les ports de la Manche',
  'Syndicats et patronat au Havre avant la Grande Guerre',
  'Histoire du mouvement ouvrier portuaire, 1880-1914, essai',
  'La Compagnie générale transatlantique et ses dockers',
  'Justice et répression : l’affaire Jules Durand en 1910',
  'La journée de dix heures : revendications et conflits',
  'Métiers du port et concurrence entre équipes de manutention',
];

/** `n` références de taille courante : une ligne de 106 caractères en moyenne, clé `[@id]` comprise. */
const citationsOf = (n: number): Array<{ id: string; author: string; title: string; year: string }> =>
  Array.from({ length: n }, (_, i) => ({
    // `pigenet1990a` : la clé que Zotero et Better BibTeX fabriquent, nom, année et lettre.
    id: `${AUTHORS[i % AUTHORS.length].split(',')[0].toLowerCase()}${1980 + (i % 30)}${'abcdefghij'[Math.floor(i / 5) % 10]}`,
    author: AUTHORS[i % AUTHORS.length],
    title: TITLES[(i * 3) % TITLES.length],
    year: String(1980 + (i % 30)),
  }));

describe.skipIf(!available)('slides par le moteur embarqué réel (GGUF donné par CLIODECK_TEST_GGUF)', () => {
  it('un document de 16 000 caractères : des slides tirées de son début, et la coupe dite', async () => {
    const llm = instrumentLLM(new EmbeddedProvider({ modelPath: GGUF ?? '', modelId: 'qwen2.5-0.5b' }), 'embedded');
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const window = {
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } as unknown as BrowserWindow;
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const source = SENTENCE.repeat(110);
    try {
      const content = await service.generateSlides(source, 'fr', window);
      expect(sent.find((s) => s.channel === 'slides:stream-error')).toBeUndefined();
      expect(content.trim().length).toBeGreaterThan(0);
      const done = sent.find((s) => s.channel === 'slides:stream-done')?.payload as
        | {
            content: string;
            sourceCut?: { readChars: number; totalChars: number };
            bibliographyCut?: { kept: number; total: number };
          }
        | undefined;
      expect(done?.sourceCut?.totalChars).toBe(source.length);
      expect(done?.sourceCut?.readChars).toBeGreaterThan(0);
      expect(done?.sourceCut?.readChars).toBeLessThan(source.length);
      expect(done?.bibliographyCut).toBeUndefined();
      if (REPORT) {
        appendFileSync(
          REPORT,
          `${JSON.stringify({
            label: 'slides-16000',
            sourceChars: source.length,
            readChars: done?.sourceCut?.readChars,
            outputChars: content.length,
            head: content.slice(0, 160),
          })}\n`
        );
      }
    } finally {
      await llm.dispose();
    }
  }, 300_000);

  it('5 000 caractères et 50 références de taille courante : le document est lu, et la bibliographie bornée', async () => {
    const llm = instrumentLLM(new EmbeddedProvider({ modelPath: GGUF ?? '', modelId: 'qwen2.5-0.5b' }), 'embedded');
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const window = {
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } as unknown as BrowserWindow;
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const source = SENTENCE.repeat(34).trim();
    const citations = citationsOf(50);
    try {
      const content = await service.generateSlides(source, 'fr', window, citations);
      expect(sent.find((s) => s.channel === 'slides:stream-error')).toBeUndefined();
      const done = sent.find((s) => s.channel === 'slides:stream-done')?.payload as
        | {
            content: string;
            sourceCut?: { readChars: number; totalChars: number };
            bibliographyCut?: { kept: number; total: number };
          }
        | undefined;
      // Le document est lu, en entier ou presque : les deux tiers de la place au moins lui reviennent.
      const readChars = done?.sourceCut?.readChars ?? source.length;
      expect(readChars).toBeGreaterThan(source.length / 2);
      expect(done?.bibliographyCut?.total).toBe(50);
      expect(done?.bibliographyCut?.kept).toBeGreaterThan(0);
      expect(done?.bibliographyCut?.kept).toBeLessThan(50);
      if (REPORT) {
        appendFileSync(
          REPORT,
          `${JSON.stringify({
            label: 'slides-5000+bib-50',
            sourceChars: source.length,
            avgCitationLine: Math.round(
              citations.reduce((sum, c) => sum + `- [@${c.id}] ${c.author} (${c.year}). *${c.title}*`.length, 0) /
                citations.length
            ),
            readChars,
            bibliographyCut: done?.bibliographyCut,
            outputChars: content.length,
            mentionsDockers: /docker/i.test(content),
            head: content.slice(0, 200),
          })}\n`
        );
      }
    } finally {
      await llm.dispose();
    }
  }, 300_000);

  it('« Arrêter » pendant les slides : la main revient en moins de 2 s, et le texte déjà reçu reste', async () => {
    const llm = instrumentLLM(new EmbeddedProvider({ modelPath: GGUF ?? '', modelId: 'qwen2.5-0.5b' }), 'embedded');
    const service = new SlidesGenerationService();
    service.setLLMProvider(llm);
    const sent: Array<{ channel: string; payload: unknown }> = [];
    let pieces = 0;
    let firstAt = 0;
    let cancelledAt = 0;
    // « Arrêter » une fois quarante morceaux affichés : le modèle est en train d'écrire.
    const window = {
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
          if (channel !== 'slides:stream') return;
          pieces += 1;
          if (pieces === 1) firstAt = performance.now();
          if (pieces === 40) {
            cancelledAt = performance.now();
            service.cancelGeneration();
          }
        },
      },
    } as unknown as BrowserWindow;
    try {
      const content = await service.generateSlides(SENTENCE.repeat(30).trim(), 'fr', window);
      const stopMs = performance.now() - cancelledAt;
      const streamed = sent
        .filter((s) => s.channel === 'slides:stream')
        .map((s) => String(s.payload))
        .join('');
      const done = sent.find((s) => s.channel === 'slides:stream-done')?.payload as { content: string } | undefined;
      if (REPORT) {
        appendFileSync(
          REPORT,
          `${JSON.stringify({ label: 'slides-arreter', stopMs: Math.round(stopMs), writingMs: Math.round(cancelledAt - firstAt), pieces, streamedChars: streamed.length, outputChars: content.length })}\n`
        );
      }

      expect(cancelledAt).toBeGreaterThan(0);
      // Les quarante morceaux sont arrivés au fil de la génération, au moins une milliseconde par
      // jeton : sur le code d'avant, ils arrivaient d'un bloc, après la fin, et l'arrêt ne coupait rien.
      expect(cancelledAt - firstAt).toBeGreaterThan(39);
      expect(stopMs).toBeLessThan(2000);
      expect(sent.find((s) => s.channel === 'slides:stream-error')).toBeUndefined();
      expect(streamed.trim().length).toBeGreaterThan(0);
      expect(content.trim().length).toBeGreaterThan(0);
      expect(done?.content).toBe(content);
    } finally {
      await llm.dispose();
    }
  }, 300_000);
});
