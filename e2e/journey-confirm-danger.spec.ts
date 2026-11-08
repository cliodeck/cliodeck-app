/**
 * Purger le journal de recherche : aux deux questions, Annuler a le focus ET se voit comme le bouton
 * actif ; Confirmer, rouge, ne ressemble pas au bouton par défaut (BT1-7, contrôle C48).
 *
 * Au second dialogue, le focus posé par script juste après un clic de souris n'allumait pas
 * `:focus-visible` : Annuler restait gris, sans anneau, et seul Confirmer, en aplat d'accent,
 * avait l'air du bouton actif. Seule l'app réelle le montre : jsdom ne calcule pas `:focus-visible`.
 * Vrais clics, comme l'auteur ; rien n'est purgé, le test refuse à la fin.
 *
 * Sans aplat, le libellé rouge de Confirmer se lit sur le panneau sombre : en teinte pure, il y
 * tombait à 2,75:1 une fois survolé. Le contraste se mesure ici sur la cascade réelle.
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

/**
 * Le contraste WCAG du libellé de Confirmer sur ce que l'écran montre derrière lui : son fond
 * teinté, posé sur le panneau du dialogue. Mesuré une fois ses transitions finies.
 */
const confirmLabelContrast = (window: Page) =>
  confirmButton(window).evaluate(async (button) => {
    await Promise.all(button.getAnimations().map((animation) => animation.finished));
    const parse = (value: string): number[] => {
      const srgb = /^color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([-\d.e]+))?\)$/.exec(value);
      if (srgb) return [1, 2, 3].map((i) => Number(srgb[i]) * 255).concat(srgb[4] === undefined ? 1 : Number(srgb[4]));
      const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
      if (rgb) return [1, 2, 3].map((i) => Number(rgb[i])).concat(rgb[4] === undefined ? 1 : Number(rgb[4]));
      throw new Error(`couleur non lue : ${value}`);
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const luminance = (rgb: number[]) => {
      const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    };
    const dialog = button.closest('.confirm-dialog');
    if (!dialog) throw new Error('Confirmer hors du dialogue');
    const panel = parse(getComputedStyle(dialog).backgroundColor);
    const background = over(parse(getComputedStyle(button).backgroundColor), panel);
    const text = over(parse(getComputedStyle(button).color), background.concat(1));
    const [hi, lo] = [luminance(text), luminance(background)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });

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

    // La souris est restée sur Confirmer : c'est son état survolé qu'on lit, en thème sombre (celui
    // d'un userData neuf), le pire cas. Le libellé doit atteindre le seuil AA d'un texte de 14 px.
    await confirmButton(window).hover();
    expect(await confirmLabelContrast(window)).toBeGreaterThanOrEqual(4.5);
    await expect(cancelButton(window)).toBeFocused();

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
