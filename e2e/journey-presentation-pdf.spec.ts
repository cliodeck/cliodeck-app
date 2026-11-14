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
 * Le chemin de sortie a une apostrophe et une esperluette, comme celui que la fenêtre
 * propose pour un projet nommé « Séminaire d'histoire » : la validation de l'IPC les
 * refusait, reste d'un temps où ce chemin passait par un shell (S12-1-3).
 *
 * Une diapositive cite du code qui contient `---` et `Note:`, puis porte une vraie note : le
 * plugin markdown de reveal.js redécoupait chaque section dans le navigateur, sans rien savoir
 * des blocs de code. Le `---` du code ajoutait une page, et la vraie note s'imprimait sur la
 * diapositive (S12-2-3). Le texte du PDF, lu par pdftotext quand il est là, le montre : le
 * code reste entier, la note n'est pas imprimée (`showNotes` est faux). Une cinquième diapositive
 * cache un `Note:` dans un commentaire (Cmd+/) et en cite un en tête d'un bloc de code indenté :
 * ni l'un ni l'autre n'ouvre de notes, et le texte qui les suit reste projeté (revue de L10-3).
 * Deux autres portent un `Note:` tapé juste sous un élément HTML refermé, puis sous un `</div>` :
 * pour CommonMark, il est dans le bloc HTML, et la note s'imprimait sur la diapositive (seconde
 * revue de L10-3). Elle reste privée.
 *
 * reveal.js est chargé depuis son CDN : sans réseau, le test est sauté. C'est le seul test qui
 * passe par le vrai plugin : à relancer si `REVEAL_VERSION` change.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdftotextAvailable, toolEnv } from '../backend/__tests__/helpers/native-guards';
import { launchApp } from './_helpers/launch';

const DECK = [
  '# Les archives et la machine\n\nIntroduction',
  '## Deuxième diapositive\n\n- premier point\n- second point',
  '## Troisième diapositive\n\nConclusion',
  '## Exemple de syntaxe\n\n```markdown\n---\nNote: CODENOTE dans le code\n```\n\nSuite du texte visible.\n\n' +
    'Note:\nVRAIENOTE à ne pas projeter.',
  '## Commentaire\n\n<!--\nNote: NOTECOMMENTEE\n-->\n\nTexte après le commentaire.\n\n' +
    '    Note: CODEINDENTE\n    x <- 1\n\nSuite après le code indenté.',
  '## Légende\n\n<p class="legende">Légende de la carte.</p>\nNote: NOTEAPRESHTML à ne pas projeter.',
  '## Colonnes\n\n<div class="colonnes">\n\nTexte en colonnes.\n\n</div>\nNote: NOTEAPRESDIV à ne pas projeter.',
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
  const outputPath = join(outDir, "Séminaire d'histoire", 'S&P présentation.pdf');

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
    if (pdftotextAvailable()) {
      const text = execFileSync('pdftotext', [outputPath, '-'], { encoding: 'utf8', env: toolEnv() });
      expect(text).not.toContain('VRAIENOTE');
      expect(text).toContain('Note: CODENOTE dans le code');
      expect(text).toContain('Suite du texte visible.');
      expect(text).not.toContain('NOTECOMMENTEE');
      expect(text).toContain('Texte après le commentaire.');
      expect(text).toContain('Note: CODEINDENTE');
      expect(text).toContain('Suite après le code indenté.');
      expect(text).toContain('Légende de la carte.');
      expect(text).toContain('Texte en colonnes.');
      expect(text).not.toMatch(/NOTEAPRES|Note: NOTE/);
    }
    expect(metadata.pageCount).toBe(7);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
