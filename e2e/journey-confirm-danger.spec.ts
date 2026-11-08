/**
 * Purger le journal de recherche : aux deux questions, Annuler a le focus ET se voit comme le bouton
 * actif ; Confirmer, rouge, ne ressemble pas au bouton par défaut (BT1-7, contrôle C48).
 *
 * Au second dialogue, le focus posé par script juste après un clic de souris n'allumait pas
 * `:focus-visible` : Annuler restait gris, sans anneau, et seul Confirmer, en aplat d'accent,
 * avait l'air du bouton actif. Seule l'app réelle le montre : jsdom ne calcule pas `:focus-visible`.
 * Vrais clics, comme l'auteur ; rien n'est purgé, le test refuse à la fin.
 */

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const question = (window: Page) => window.locator('.confirm-dialog');
const cancelButton = (window: Page) => question(window).locator('.confirm-dialog-btn-cancel');
const confirmButton = (window: Page) => question(window).locator('.confirm-dialog-btn-confirm');
const purgeButton = (window: Page) => window.locator('.journal-purge-btn');

/** L'anneau que l'écran donne à Annuler : c'est lui qui dit quel bouton Entrée actionnera. */
const cancelOutline = (window: Page) => cancelButton(window).evaluate((button) => getComputedStyle(button).outlineStyle);

function makeArticle(): { dir: string; projectJson: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-purge-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000107',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Article\n\nTexte du manuscrit.\n');
  return { dir, projectJson };
}

test('purge du journal : aux deux questions, Annuler porte l’anneau du focus, et Confirmer est en danger', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeArticle();
  try {
    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, project.projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 20_000 });

    // L'ouverture du projet a ouvert une session : le journal n'est pas vide.
    await window.locator('#right-tab-journal').click();
    await expect(purgeButton(window)).toBeEnabled({ timeout: 15_000 });

    await purgeButton(window).click();
    await expect(question(window)).toContainText('Supprimer TOUT le journal');
    await expect(cancelButton(window)).toBeFocused();
    const first = await cancelOutline(window);

    await confirmButton(window).click();
    await expect(question(window)).toContainText('Cette action est irréversible');
    await expect(cancelButton(window)).toBeFocused();
    const second = await cancelOutline(window);

    expect(first).not.toBe('none');
    expect(second).not.toBe('none');
    await expect(confirmButton(window)).toHaveClass(/\bis-danger\b/);

    // Annuler : rien n'est purgé.
    await cancelButton(window).click();
    await expect(question(window)).toHaveCount(0);
    await expect(purgeButton(window)).toBeEnabled();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});
