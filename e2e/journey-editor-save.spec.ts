/**
 * Ce qui est tapé puis enregistré se retrouve sur le disque, et rien de
 * l'ancien texte ne survit à côté.
 *
 * C'est le parcours où des frappes ont déjà été perdues (rc.4 : quitter juste
 * après avoir tapé ; rc.5 : bascule entre chapitres). Les tests unitaires
 * couvrent les magasins ; ici l'application ouvre un vrai projet, l'éditeur
 * CodeMirror reçoit de vraies touches, et l'assertion porte sur **le fichier**.
 *
 * Le projet est posé sur le disque plutôt que créé par la modale : ouvrir est
 * le chemin qu'emprunte aussi un projet reçu d'un collègue, et cela évite
 * l'accompagnement au démarrage, qui n'est pas l'objet du test.
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const ORIGINAL = '# Chapitre premier\n\nTexte déjà écrit.\n';
const TYPED = 'Une phrase tapée dans l’éditeur.';

function makeProject(): { dir: string; projectJson: string; documentMd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-projet-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const documentMd = join(dir, 'document.md');
  writeFileSync(documentMd, ORIGINAL);
  return { dir, projectJson, documentMd };
}

test('le texte tapé puis enregistré atteint document.md', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    // Le sélecteur de fichier natif bloquerait le test : on répond à sa place.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, projet.projectJson);

    await window.locator('button[title="Ouvrir un projet"]').first().click();

    const editor = window.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Texte déjà écrit', { timeout: 20_000 });

    await editor.click();
    await window.keyboard.press('ControlOrMeta+End');
    await window.keyboard.type(`\n${TYPED}\n`);

    await window.locator('.toolbar-btn[title="Enregistrer"]').first().click();

    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toContain(TYPED);

    // Le texte d'origine est conservé : on ajoute, on n'écrase pas.
    expect(readFileSync(projet.documentMd, 'utf8')).toContain('Texte déjà écrit');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});
