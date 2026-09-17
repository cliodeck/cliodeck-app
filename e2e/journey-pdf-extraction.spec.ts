/**
 * Le chemin d'entrée des PDF, dans l'application réelle.
 *
 * `pdf:extractMetadata` passe par le worker isolé — un processus fils lancé
 * avec le Node d'Electron depuis la rc.6 (#77/#110). Les tests unitaires
 * simulent ce processus ; ici il est lancé pour de bon, avec l'app, sur le PDF
 * de test versionné. C'est le seul endroit où l'on vérifie que le worker
 * démarre, trouve pdfjs et rend son JSON dans l'app telle qu'elle tourne.
 *
 * Une extraction qui échoue renvoie un titre tiré du nom de fichier et
 * `pageCount: 0` : le test regarde donc le nombre de pages, qu'un repli ne
 * peut pas fabriquer.
 */

import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './_helpers/launch';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'backend/core/pdf/__tests__/fixtures/extraction-fixture.pdf',
);

test('extrait titre et nombre de pages d’un PDF via le worker isolé', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  try {
    const response = await window.evaluate(
      (filePath) =>
        (window as unknown as {
          electron: { pdf: { extractMetadata: (p: string) => Promise<unknown> } };
        }).electron.pdf.extractMetadata(filePath),
      FIXTURE,
    );

    const payload = response as { success?: boolean; metadata?: { title?: string; pageCount?: number } };
    const metadata = payload.metadata ?? (payload as { title?: string; pageCount?: number });

    expect(metadata.pageCount).toBe(2);
    expect(metadata.title).toBe('Histoire des archives numériques');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
