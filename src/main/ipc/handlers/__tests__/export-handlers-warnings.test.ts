/**
 * Les réserves d'un export passent par l'enveloppe d'`outcomeResponse` (L07-2, sur L09-2).
 *
 * Un export qui a écrit son document avec des réserves (une image introuvable, remplacée par sa
 * légende) est une réussite partielle : `success: true` et `warnings`, que la modale relit par
 * `readExportWarnings` (`ExportWarnings`, A27). Un échec garde sa forme : `errorCode`,
 * `errorParams` et `timeLimitMinutes` sont ceux que lit `exportErrorMessage`.
 *
 * Les vrais handlers, la vraie validation, le vrai lecteur du renderer ; seuls les services
 * d'export sont simulés : on regarde ce que le handler fait de leur résultat.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportResult } from '../../../services/export-time-limit.js';
import { readExportWarnings } from '../../../../renderer/src/components/Export/ExportWarnings';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  result: { success: true } as ExportResult,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  powerMonitor: { on: () => undefined },
}));
vi.mock('../../../services/pdf-export.js', () => ({
  pdfExportService: { exportToPDF: async () => h.result },
}));
vi.mock('../../../services/word-export.js', () => ({
  wordExportService: { exportToWord: async () => h.result },
}));
vi.mock('../../../services/revealjs-export.js', () => ({ revealJsExportService: {} }));

import { setupExportHandlers } from '../export-handlers.js';

const IMAGE_WARNING = {
  code: 'export.imagesNotFound',
  params: { files: 'images/plan.png', count: 1 },
};

async function call(channel: string): Promise<unknown> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`handler absent : ${channel}`);
  return handler({ sender: {} }, {
    projectPath: '/tmp/projet',
    projectType: 'article',
    content: 'Un texte.',
    outputPath: '/tmp/projet/sortie',
  });
}

beforeEach(() => {
  h.handlers.clear();
  setupExportHandlers();
});

describe.each(['pdf-export:export', 'word-export:export'])('%s', (channel) => {
  it('une réussite avec réserves : success, la valeur, et les avertissements dans l’enveloppe', async () => {
    h.result = { success: true, outputPath: '/tmp/projet/sortie', warnings: [IMAGE_WARNING] };

    const response = await call(channel);

    expect(response).toEqual({ success: true, outputPath: '/tmp/projet/sortie', warnings: [IMAGE_WARNING] });
    expect(readExportWarnings(response).issues).toEqual([IMAGE_WARNING]);
  });

  it('une réussite sans réserve n’a pas de warnings', async () => {
    h.result = { success: true, outputPath: '/tmp/projet/sortie', missingCsl: '/tmp/projet/style.csl' };

    const response = await call(channel);

    expect(response).toEqual({
      success: true,
      outputPath: '/tmp/projet/sortie',
      missingCsl: '/tmp/projet/style.csl',
    });
    expect(readExportWarnings(response)).toMatchObject({ issues: [], missingCsl: '/tmp/projet/style.csl' });
  });

  it('un échec part tel quel, avec son code et ses paramètres', async () => {
    h.result = {
      success: false,
      error: 'Pandoc failed with code 43',
      errorCode: 'export.imageNeedsRsvgConvert',
      errorParams: { file: 'images/schema.svg' },
    };

    const response = await call(channel);

    expect(response).toEqual(h.result);
    expect(readExportWarnings(response).issues).toEqual([]);
  });
});
