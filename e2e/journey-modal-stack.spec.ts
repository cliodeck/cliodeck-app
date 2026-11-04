/**
 * Rien ne se ferme sous les yeux : Échap ne ferme que ce qui est au-dessus, et rien ne disparaît
 * pendant qu'on le lit.
 *
 * Refuser une confirmation à Échap fermait aussi les Réglages, avec tout ce qui n'y était pas
 * enregistré. L'app réelle compte ici plus qu'ailleurs : une vraie frappe vide les microtâches
 * entre deux écouteurs de `document`, si bien que le piège qui vient de répondre est déjà démonté
 * quand le suivant s'interroge. Sous Vitest, `fireEvent` n'en montre rien.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const DOCUMENT = '# Article\n\nTexte du manuscrit.\n';
/** Écrite à la main : `yaml.dump` n'y remettrait ni le commentaire ni les guillemets. */
const RECIPE = `# Une recette écrite à la main
name: ma-recette
version: '1'
description: Une recette
steps:
  - id: s1
    kind: brainstorm
`;
/** Déjà à la forme de `yaml.dump`, comme après un enregistrement depuis le formulaire, puis commentée. */
const RECIPE_FROM_FORM = `# Un commentaire ajouté à la main
name: depuis-le-formulaire
version: "1"
description: Une recette
inputs: {}
steps:
  - id: s1
    kind: brainstorm
outputs: {}
`;
/** Un paramètre « plan » : le champ est un `textarea`, à plusieurs lignes. */
const RECIPE_WITH_PLAN = `name: avec-un-plan
version: '1'
description: Une recette à paramètres
inputs:
  plan:
    type: string
    required: true
steps:
  - id: s1
    kind: brainstorm
`;
const CAUSE = 'Failed to save HNSW index: EISDIR';
const RUNNING = { current: 20, total: 100, status: 'Building HNSW index…', percentage: 20, phase: 'running' };
const DONE = { current: 100, total: 100, status: 'Rebuild complete', percentage: 100, phase: 'done' };
const FAILED = { current: 90, total: 100, status: `Error: ${CAUSE}`, percentage: 90, phase: 'failed', error: CAUSE };

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArticle(): { dir: string; projectJson: string; recipe: string; recipeFromForm: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-pile-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck', 'recipes'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000055',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), DOCUMENT);
  const recipe = join(dir, '.cliodeck', 'recipes', 'ma-recette.yaml');
  writeFileSync(recipe, RECIPE);
  const recipeFromForm = join(dir, '.cliodeck', 'recipes', 'depuis-le-formulaire.yaml');
  writeFileSync(recipeFromForm, RECIPE_FROM_FORM);
  writeFileSync(join(dir, '.cliodeck', 'recipes', 'avec-un-plan.yaml'), RECIPE_WITH_PLAN);
  return { dir, projectJson, recipe, recipeFromForm };
}

async function start(): Promise<{ app: ElectronApplication; window: Page } | null> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return null;
  }
  toClean.push(outcome.value.userDataDir);
  return { app: outcome.value.app, window: outcome.value.window };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 20_000 });
}

const settingsHeading = (window: Page) => window.locator('#settings-modal-title');
const confirmDialog = (window: Page) => window.locator('.confirm-dialog');
const focusedClass = (window: Page) => window.evaluate(() => document.activeElement?.className ?? '');

async function openSettings(window: Page): Promise<void> {
  // Même événement que le raccourci du menu.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-settings-modal')));
  await expect(settingsHeading(window)).toBeVisible({ timeout: 15_000 });
}

/** Réglages → Éditeur → un champ modifié, non enregistré. */
async function changeFontSize(window: Page): Promise<ReturnType<Page['locator']>> {
  await window.getByRole('button', { name: 'Éditeur', exact: true }).click();
  const field = window.locator('.settings-modal input[type="number"]').first();
  await field.fill('21');
  return field;
}

const resetButton = (window: Page) => window.locator('.settings-modal button[title="Réinitialiser"]');

async function openRecipes(window: Page): Promise<void> {
  await openSettings(window);
  await window.getByRole('button', { name: 'Expert', exact: true }).click();
  await window.getByRole('button', { name: /Recettes/ }).first().click();
}

const recipeAction = (window: Page, file: string, action: 'Éditer' | 'Lancer') =>
  window.locator('li', { hasText: file }).getByRole('button', { name: action });

/** La fenêtre ouverte par-dessus les Réglages : l'éditeur de recette ou son exécution. */
const nestedOverlay = (window: Page) => window.locator('.settings-modal .settings-modal');

const sendProgress = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ BrowserWindow }, progress) => {
    BrowserWindow.getAllWindows()[0].webContents.send('project:rebuild-progress', progress);
  }, event);

test('Réglages, champ modifié, Réinitialiser, Échap : seule la question se ferme, le champ et le focus restent', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    const field = await changeFontSize(window);
    await resetButton(window).click();
    await expect(confirmDialog(window)).toBeVisible();
    expect(await focusedClass(window)).toBe('confirm-dialog-btn-cancel');

    await window.keyboard.press('Escape');

    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();
    await expect(field).toHaveValue('21');
    // Le focus revient sur le déclencheur, dans les Réglages, pas au corps de la page.
    await expect(resetButton(window)).toBeFocused();

    // Le Échap suivant ferme bien les Réglages.
    await window.keyboard.press('Escape');
    await expect(settingsHeading(window)).toBeHidden();
  } finally {
    await app.close();
  }
});

test('l’écouteur des Réglages passe après celui de la question : le même Échap ne les ferme pas pour autant', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    const field = await changeFontSize(window);
    await resetButton(window).click();
    await expect(confirmDialog(window)).toBeVisible();

    // Le panneau de droite qui change fait refaire son rendu à MainLayout : le `onClose` en ligne des
    // Réglages change, et leur écouteur repasse après celui de la question sur `document`.
    await window.evaluate(() => document.querySelector<HTMLElement>('#right-tab-journal')?.click());
    await expect(window.locator('#right-tab-journal')).toHaveAttribute('aria-selected', 'true');

    await window.keyboard.press('Escape');

    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();
    await expect(field).toHaveValue('21');
  } finally {
    await app.close();
  }
});

test('Échap maintenu sur une question : la répétition du clavier ne ferme pas les Réglages', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    const field = await changeFontSize(window);
    await resetButton(window).click();
    await expect(confirmDialog(window)).toBeVisible();

    // Deux `down` sans `up` : le second porte `repeat: true`, comme une touche qui reste enfoncée.
    await window.keyboard.down('Escape');
    await expect(confirmDialog(window)).toHaveCount(0);
    await window.keyboard.down('Escape');
    await window.keyboard.up('Escape');

    await expect(settingsHeading(window)).toBeVisible();
    await expect(field).toHaveValue('21');

    // La touche relâchée, le geste suivant ferme bien les Réglages.
    await window.keyboard.press('Escape');
    await expect(settingsHeading(window)).toBeHidden();
  } finally {
    await app.close();
  }
});

test('une modale ouverte par le menu pendant une question reste dessous : Tab et Échap vont à la question', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const about = window.locator('.about-modal');
  const inQuestion = () => window.evaluate(() => document.activeElement?.closest('.confirm-dialog') !== null);

  try {
    await openSettings(window);
    const field = await changeFontSize(window);
    await resetButton(window).click();
    await expect(confirmDialog(window)).toBeVisible();

    // Même événement que l'entrée du menu.
    await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-about-dialog')));
    await expect(about).toBeVisible({ timeout: 15_000 });

    for (let press = 0; press < 4; press += 1) {
      await window.keyboard.press('Tab');
      expect(await inQuestion()).toBe(true);
    }

    await window.keyboard.press('Escape');
    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(about).toBeVisible();
    await expect(field).toHaveValue('21');

    await window.keyboard.press('Escape');
    await expect(about).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();
    await expect(field).toHaveValue('21');
  } finally {
    await app.close();
  }
});

test('reconstruction par-dessus les Réglages : Échap ne ferme que le message, et rien sous le voile', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;

  try {
    await openSettings(window);
    const field = await changeFontSize(window);

    await sendProgress(app, RUNNING);
    await expect(window.getByRole('progressbar')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('progressbar')).toBeVisible();
    await expect(settingsHeading(window)).toBeVisible();

    await sendProgress(app, FAILED);
    await expect(window.locator('.rebuild-failure-cause')).toContainText(CAUSE);
    await window.keyboard.press('Escape');
    await expect(window.locator('.rebuild-failure-cause')).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();
    await expect(field).toHaveValue('21');

    await sendProgress(app, RUNNING);
    await sendProgress(app, DONE);
    await expect(window.getByRole('progressbar')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(settingsHeading(window)).toBeHidden();
  } finally {
    await app.close();
  }
});

test('confirmation par-dessus l’éditeur : une proposition en attente n’est pas rejetée par le même Échap', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson } = makeArticle();

  try {
    await openProject(app, window, projectJson);
    await window.locator('.codemirror-editor .cm-line', { hasText: 'Texte du manuscrit' }).click();
    await window.evaluate(() => {
      (window as unknown as { __cliodeckProposals: { inject(p: object): void } }).__cliodeckProposals.inject({
        proposed: 'INJECTÉ',
      });
    });
    const proposal = window.locator('.cm-proposal-box');
    await expect(proposal).toBeVisible();

    // « Nouveau fichier » pose sa question sur le document ouvert.
    await window.locator('button[title="Nouveau fichier"]').first().click();
    await expect(confirmDialog(window)).toBeVisible();
    expect(await focusedClass(window)).toBe('confirm-dialog-btn-cancel');

    await window.keyboard.press('Escape');

    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(proposal).toBeVisible();
  } finally {
    await app.close();
  }
});

test('livre : ce qu’Échap ferme de plus proche ne ferme pas le panneau de recherche', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-pile-livre-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  writeFileSync(join(dir, 'chapters', '01-un.md'), '# Un\n\nTexte du manuscrit.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000056',
      name: 'Livre E2E',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' }],
    }),
  );

  try {
    await openProject(app, window, projectJson);
    await window.locator('button[title="Chercher dans le livre"]').click();
    const panel = window.locator('.manuscript-search');
    await expect(panel).toBeVisible();

    // La recherche de CM6 prend Échap pour elle.
    await window.locator('.codemirror-editor .cm-line', { hasText: 'Texte du manuscrit' }).click();
    await window.keyboard.press('ControlOrMeta+f');
    await expect(window.locator('.cm-search')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.locator('.cm-search')).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Le renommage d'un chapitre aussi.
    await window.locator('.chapter-navigator').getByText('Un', { exact: true }).dblclick();
    const rename = window.locator('.chapter-title-input');
    await expect(rename).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(rename).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Une modale par-dessus : Échap la ferme, elle, et le panneau reste.
    await openSettings(window);
    await window.keyboard.press('Escape');
    await expect(settingsHeading(window)).toBeHidden();
    await expect(panel).toBeVisible();

    // Plus rien de proche : Échap ferme le panneau.
    await window.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('éditeur de recette : la question quand il y a à perdre, une seule, et le fichier intact', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, recipe } = makeArticle();

  try {
    await openProject(app, window, projectJson);
    await openSettings(window);
    await window.getByRole('button', { name: 'Expert', exact: true }).click();
    await window.getByRole('button', { name: /Recettes/ }).first().click();
    await window
      .locator('li', { hasText: 'ma-recette.yaml' })
      .getByRole('button', { name: 'Éditer' })
      .click();

    const editorOverlay = window.locator('.settings-modal .settings-modal');
    const nameField = editorOverlay.locator('.config-field input').first();
    await expect(nameField).toHaveValue('ma-recette');

    // Rien de modifié : passer en YAML et revenir ne pose pas de question.
    await editorOverlay.locator('button[title="YAML"]').click();
    await expect(editorOverlay.locator('.cm-content')).toContainText('Une recette écrite à la main');
    await editorOverlay.locator('button[title="Formulaire"]').click();
    await expect(editorOverlay.getByText('non enregistré')).toHaveCount(0);

    await nameField.fill('autre-nom');
    await expect(editorOverlay.getByText('non enregistré')).toBeVisible();

    // Échap : la question, puis un second Échap la refuse. Une seule, et tout reste.
    await window.keyboard.press('Escape');
    await expect(confirmDialog(window)).toBeVisible();
    await expect(confirmDialog(window)).toContainText('modifications non enregistrées');
    await window.keyboard.press('Escape');
    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(nameField).toHaveValue('autre-nom');
    await expect(settingsHeading(window)).toBeVisible();

    // Le fond, imbriqué dans celui des Réglages : la même question.
    const box = await editorOverlay.boundingBox();
    if (!box) throw new Error('fenêtre introuvable');
    await window.mouse.click(box.x + 8, box.y + 8);
    await expect(confirmDialog(window)).toBeVisible();
    await window.locator('.confirm-dialog-btn-cancel').click();
    await expect(nameField).toHaveValue('autre-nom');

    // Le champ revenu à sa valeur : plus rien à perdre, et Échap ferme sans question.
    await nameField.fill('ma-recette');
    await expect(editorOverlay.getByText('non enregistré')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(editorOverlay).toHaveCount(0);
    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();

    expect(readFileSync(recipe, 'utf8')).toBe(RECIPE);
  } finally {
    await app.close();
  }
});

test('éditeur de recette : retirer un commentaire dans le YAML s’enregistre, même quand il reste la réécriture du fichier', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, recipeFromForm } = makeArticle();

  try {
    await openProject(app, window, projectJson);
    await openRecipes(window);
    await recipeAction(window, 'depuis-le-formulaire.yaml', 'Éditer').click();
    const overlay = nestedOverlay(window);
    await overlay.locator('button[title="YAML"]').click();
    const yaml = overlay.locator('.cm-content');
    await expect(yaml).toContainText('Un commentaire ajouté');

    await yaml.click();
    await window.keyboard.press('ControlOrMeta+ArrowUp');
    await window.keyboard.press('Shift+ArrowDown');
    await window.keyboard.press('Delete');
    await expect(yaml).not.toContainText('Un commentaire ajouté');
    await expect(overlay.getByText('non enregistré')).toBeVisible();

    // Échap pose la question, et le refus laisse tout en place.
    await window.keyboard.press('Escape');
    await expect(confirmDialog(window)).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(confirmDialog(window)).toHaveCount(0);

    await overlay.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(overlay.getByText('non enregistré')).toHaveCount(0);
    expect(readFileSync(recipeFromForm, 'utf8')).toBe(RECIPE_FROM_FORM.split('\n').slice(1).join('\n'));
  } finally {
    await app.close();
  }
});

test('éditeur de recette : Tab depuis le YAML reste dans l’éditeur, et Échap rend le focus à son déclencheur', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson } = makeArticle();

  try {
    await openProject(app, window, projectJson);
    await openRecipes(window);
    const edit = recipeAction(window, 'ma-recette.yaml', 'Éditer');
    await edit.click();
    const overlay = nestedOverlay(window);
    await overlay.locator('button[title="YAML"]').click();
    const yaml = overlay.locator('.cm-content');
    await expect(yaml).toContainText('Une recette écrite à la main');
    await yaml.click();

    for (let press = 0; press < 6; press += 1) {
      await window.keyboard.press('Tab');
      expect(
        await window.evaluate(() => {
          const nested = document.querySelector('.settings-modal .settings-modal');
          return nested?.contains(document.activeElement) === true;
        }),
      ).toBe(true);
    }

    await window.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(settingsHeading(window)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('fenêtre d’exécution : un plan saisi ne part ni par un clic à côté ni par Échap, et le X reste un geste franc', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson } = makeArticle();
  const PLAN = 'Un long plan rédigé à la main\nsur plusieurs lignes';

  try {
    await openProject(app, window, projectJson);
    await openRecipes(window);
    await recipeAction(window, 'avec-un-plan.yaml', 'Lancer').click();
    const overlay = nestedOverlay(window);
    const plan = overlay.locator('textarea');
    await expect(plan).toBeVisible({ timeout: 10_000 });

    await plan.fill(PLAN);
    const box = await overlay.boundingBox();
    if (!box) throw new Error('fenêtre introuvable');
    await window.mouse.click(box.x + 8, box.y + 8);
    await expect(overlay).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(overlay).toHaveCount(1);
    await expect(plan).toHaveValue(PLAN);
    await expect(settingsHeading(window)).toBeVisible();

    await plan.fill('');
    await window.mouse.click(box.x + 8, box.y + 8);
    await expect(overlay).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();

    await recipeAction(window, 'avec-un-plan.yaml', 'Lancer').click();
    await expect(plan).toBeVisible({ timeout: 10_000 });
    await plan.fill(PLAN);
    await overlay.locator('.close-btn').click();
    await expect(overlay).toHaveCount(0);
    await expect(settingsHeading(window)).toBeVisible();
  } finally {
    await app.close();
  }
});

test('assistant de démarrage : ni un glisser hors de la carte ni un clic à côté ne perdent les réponses', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, dir } = makeArticle();
  const wizard = window.locator('.onboarding-wizard');
  const input = window.locator('.onboarding-wizard__input');
  const replay = window.getByRole('button', { name: 'Rejouer l\'assistant de démarrage' });
  /** Un point du fond, à côté de la carte. */
  const beside = async (): Promise<{ x: number; y: number }> => {
    const card = await window.locator('.onboarding-wizard__card').boundingBox();
    if (!card) throw new Error('carte introuvable');
    return { x: card.x + card.width + 40, y: card.y + card.height / 2 };
  };

  try {
    await openProject(app, window, projectJson);
    await replay.click();
    await input.fill('Un long sujet de recherche à sélectionner à la souris');

    // Une sélection commencée dans le champ et relâchée sur le fond.
    const field = await input.boundingBox();
    if (!field) throw new Error('champ introuvable');
    const outside = await beside();
    await window.mouse.move(field.x + 20, field.y + field.height / 2);
    await window.mouse.down();
    await window.mouse.move(outside.x, outside.y, { steps: 5 });
    await window.mouse.up();
    await expect(wizard).toHaveCount(1);
    await expect(input).toHaveValue(/Un long sujet/);

    // Un clic franc à côté de la carte, puis Échap.
    await window.mouse.click(outside.x, outside.y);
    await expect(wizard).toHaveCount(1);
    await window.keyboard.press('Escape');
    await expect(wizard).toHaveCount(1);
    await expect(input).toHaveValue(/Un long sujet/);

    // Un accélérateur de menu (Alt+2) ne le démonte pas davantage.
    await window.evaluate(() => window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'bibliography' })));
    await expect(window.locator('#left-tab-bibliography')).toHaveAttribute('aria-selected', 'false');
    await expect(input).toHaveValue(/Un long sujet/);

    // Le lien reste un geste franc.
    await window.locator('.onboarding-wizard__skip-link').click();
    await expect(wizard).toHaveCount(0);

    // Rien de saisi : le fond ferme.
    await replay.click();
    const free = await beside();
    await window.mouse.click(free.x, free.y);
    await expect(wizard).toHaveCount(0);

    // Écran de fin : les réponses sont écrites, et le fond ferme de nouveau.
    await replay.click();
    await input.fill('Ports baltes');
    for (let step = 0; step < 3; step += 1) {
      await window.locator('.onboarding-wizard__btn', { hasText: 'Suivant' }).click();
    }
    await window.locator('.onboarding-wizard__btn', { hasText: 'Terminer' }).click();
    await expect(window.locator('.onboarding-wizard__question')).toContainText('context.md', { timeout: 10_000 });
    expect(readFileSync(join(dir, 'context.md'), 'utf8')).toContain('Ports baltes');
    const end = await beside();
    await window.mouse.click(end.x, end.y);
    await expect(wizard).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('création de projet : Échap ferme sans rien perdre, et Tab reste dans la modale', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const content = window.locator('.create-project-content');
  const name = content.locator('input[type="text"]').first();

  try {
    await window.locator('button[title="Nouveau projet"]').first().click();
    await expect(name).toBeFocused();
    await name.fill('Mon projet');

    for (let press = 0; press < 8; press += 1) {
      await window.keyboard.press('Tab');
      expect(await window.evaluate(() => document.activeElement?.closest('.create-project-content') !== null)).toBe(true);
    }

    await window.keyboard.press('Escape');
    await expect(content).toHaveCount(0);
    await expect(confirmDialog(window)).toHaveCount(0);
    await expect(window.locator('button[title="Nouveau projet"]').first()).toBeFocused();

    await window.locator('button[title="Nouveau projet"]').first().click();
    await expect(name).toHaveValue('Mon projet');
  } finally {
    await app.close();
  }
});

test('une notification dépliée reste à son échéance, et repliée, elle part à la suivante', async () => {
  test.setTimeout(90_000);
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const toast = window.locator('.status-toast', { hasText: 'PDF sans texte exploitable' });

  try {
    await expect(window.locator('#root')).toBeVisible({ timeout: 20_000 });
    // Le canal réel de l'avertissement « PDF presque sans texte » : 12 s, avec des détails. Le
    // renderer s'y abonne au montage : on réessaie tant qu'il n'a rien reçu.
    await expect(async () => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send('pdf:low-text', {
          title: 'Un scan',
          fileName: 'scan.pdf',
          pageCount: 3,
          charsPerPage: 2,
        });
      });
      await expect(toast.first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const shownAt = Date.now();

    await toast.first().locator('.status-toast__details-btn').click();
    await expect(toast.first().locator('.status-toast__details')).toContainText('scan.pdf');

    // Au-delà de l'échéance : toujours là, et toujours dépliée.
    await window.waitForTimeout(Math.max(0, 13_500 - (Date.now() - shownAt)));
    await expect(toast.first().locator('.status-toast__details')).toContainText('scan.pdf');

    // Repliée : elle part à l'échéance suivante, sans attendre davantage.
    await toast.first().locator('.status-toast__details-btn').click();
    await expect(toast.first().locator('.status-toast__details')).toHaveCount(0);
    await expect(toast).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await app.close();
  }
});
