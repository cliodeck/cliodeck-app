/**
 * Slides d'un long document par le vrai moteur embarqué (revue de L08-4) : sauté quand aucun modèle
 * n'est donné.
 *
 *   CLIODECK_TEST_GGUF=/chemin/qwen2.5-0.5b-instruct-q4_k_m.gguf \
 *     npx vitest run src/main/services/__tests__/slides-generation-service.live.test.ts
 *
 * Le petit Qwen 2.5 0,5B suffit, et ce n'est pas le modèle de génération de production : ce test
 * vérifie le chemin, pas la qualité des slides. Avant le correctif, un document de 16 000
 * caractères donnait un résultat vide (`embedded_prompt_too_long`, terminal ignoré par le service).
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
        | { content: string; sourceCut?: { readChars: number; totalChars: number } }
        | undefined;
      expect(done?.sourceCut?.totalChars).toBe(source.length);
      expect(done?.sourceCut?.readChars).toBeGreaterThan(0);
      expect(done?.sourceCut?.readChars).toBeLessThan(source.length);
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
});
