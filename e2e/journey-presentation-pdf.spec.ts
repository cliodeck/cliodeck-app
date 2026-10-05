/**
 * L'export PDF d'une présentation rend une page par diapositive.
 *
 * C'est le seul endroit de l'application qui imprime par Chromium
 * (`printToPDF` dans une fenêtre cachée) : il dépend de la version
 * d'Electron, et aucun test unitaire ne peut le couvrir. Il a longtemps rendu
 * un PDF d'une seule diapositive sur des pages de plusieurs kilomètres —
 * taille donnée en microns là où Electron attend des pouces, mode impression
 * de reveal.js jamais déclenché —, puis a cessé de fonctionner avec
 * Electron 43, qui refuse cette taille.
 *
 * reveal.js est chargé depuis son CDN : sans réseau, le test est sauté.
 */

import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const DECK = [
  '# Les archives et la machine\n\nIntroduction',
  '## Deuxième diapositive\n\n- premier point\n- second point',
  '## Troisième diapositive\n\nConclusion',
].join('\n\n---\n\n');

type ExportBridge = {
  electron: {
    revealJsExport: {
      exportPDF: (options: object) => Promise<{ success: boolean; outputPath?: string; error?: string }>;
    };
    pdf: { extractMetadata: (filePath: string) => Promise<unknown> };
  };
};

async function cdnReachable(): Promise<boolean> {
  try {
    const response = await fetch('https://cdn.jsdelivr.net/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

test('l’export PDF d’une présentation rend une page par diapositive', async () => {
  test.skip(!(await cdnReachable()), 'CDN de reveal.js injoignable : export PDF non vérifiable hors ligne.');

  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const outDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-diapos-'));
  const outputPath = join(outDir, 'presentation.pdf');

  try {
    const result = await window.evaluate(
      (options) => (window as unknown as ExportBridge).electron.revealJsExport.exportPDF(options),
      {
        projectPath: join(outDir, 'project.json'),
        content: DECK,
        outputPath,
        metadata: { title: 'Présentation E2E' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);

    // Le PDF est relu par le worker d'extraction de l'application : une
    // diapositive par page, ni plus (pages vides) ni moins (diapositives perdues).
    const response = await window.evaluate(
      (filePath) => (window as unknown as ExportBridge).electron.pdf.extractMetadata(filePath),
      outputPath,
    );
    const payload = response as { metadata?: { pageCount?: number } };
    const metadata = payload.metadata ?? (payload as { pageCount?: number });
    expect(metadata.pageCount).toBe(3);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
