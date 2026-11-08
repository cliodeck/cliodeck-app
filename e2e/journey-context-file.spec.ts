/**
 * `context.md` écrit à la main, face à l'assistant de démarrage, aux Réglages et à l'éditeur
 * (S17-1-0, S17-1-24, décision Q6). Vraie app, vrai projet, et l'assertion porte sur les octets
 * du fichier : « Rejouer l'assistant » remplaçait deux pages de consignes, et un paragraphe ajouté
 * dans les Réglages disparaissait à la frappe suivante dans l'éditeur.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const WRITTEN_BY_HAND =
  '# Danzig\n\nProblématique : la ville libre, 1919-1939.\n\nConventions de citation : Chicago.\n\nHistoriographie : à reprendre.\n';
const TOPIC = 'Ports baltes';
const PARAGRAPH = 'Paragraphe ajouté dans les Réglages.';
/** « # Été » en Latin-1 : des octets qui ne forment pas de l'UTF-8. */
const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);

function makeProject(context?: string | Buffer): { dir: string; projectJson: string; contextMd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-contexte-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000033',
      name: 'Danzig',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), '# Manuscrit\n\nTexte du manuscrit.\n');
  const contextMd = join(dir, 'context.md');
  if (context !== undefined) writeFileSync(contextMd, context);
  return { dir, projectJson, contextMd };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 20_000 });
}

async function answerQuestions(window: Page, topic: string = TOPIC): Promise<void> {
  await window.getByRole('button', { name: 'Rejouer l\'assistant de démarrage' }).click();
  await window.locator('.onboarding-wizard__input').fill(topic);
  for (let step = 0; step < 3; step += 1) {
    await window.locator('.onboarding-wizard__btn', { hasText: 'Suivant' }).click();
  }
}

const finish = (window: Page) => window.locator('.onboarding-wizard__btn', { hasText: 'Terminer' });

/** C'est écrit : l'assistant le dit et dit où, puis c'est l'auteur qui le ferme. */
async function closeDoneScreen(window: Page): Promise<void> {
  await expect(window.locator('.onboarding-wizard__question')).toContainText('context.md', { timeout: 10_000 });
  await expect(window.locator('.onboarding-wizard__skip-link')).toHaveCount(0);
  await window.locator('.onboarding-wizard__btn', { hasText: 'Commencer' }).click();
  await expect(window.locator('.onboarding-wizard')).toHaveCount(0);
}

async function openContextSettings(window: Page): Promise<void> {
  await window.evaluate(() => {
    window.dispatchEvent(new CustomEvent('show-settings-modal'));
  });
  await window.getByRole('button', { name: 'Expert', exact: true }).click();
  await window.getByRole('button', { name: /Consignes de projet/ }).click();
  await expect(contextZone(window)).toBeEditable({ timeout: 10_000 });
}

const contextZone = (window: Page) => window.locator('.settings-content textarea.config-textarea');

/** Cmd+Fin ne déplace pas le curseur d'une zone de texte sous macOS : le texte partirait en tête. */
async function typeAtEndOfZone(window: Page, text: string): Promise<void> {
  const zone = contextZone(window);
  await zone.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await zone.pressSequentially(text);
}

/** Le tiroir du Brainstorm, une fois les Réglages fermés : il dit le vrai motif, pas « aucun fichier ». */
async function expectDrawerToSay(window: Page, reason: string): Promise<void> {
  await window.keyboard.press('Escape');
  await expect(window.locator('.settings-content')).toHaveCount(0);
  await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();
  await window.locator('.brainstorm-panel__drawer-toggle').click();
  await expect(window.locator('.brainstorm-panel__hints-refused')).toContainText(reason);
  await expect(window.locator('#brainstorm-context-drawer')).not.toContainText('Aucun fichier');
}
const saveButton = (window: Page) => window.locator('button[title="Enregistrer le contexte du projet"]');

test('rejouer l’assistant sur un context.md écrit à la main : on demande, refuser n’écrit rien, confirmer garde les deux textes', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(WRITTEN_BY_HAND);

  try {
    await openProject(app, window, project.projectJson);
    await answerQuestions(window);
    const before = statSync(project.contextMd).mtimeMs;

    // Refuser : à l'octet près, et l'assistant garde les réponses.
    await finish(window).click();
    await expect(window.locator('.confirm-dialog-message')).toContainText('Vos réponses y seront ajoutées à la suite');
    await window.locator('.confirm-dialog-btn-cancel').click();
    await expect(window.locator('.confirm-dialog')).toHaveCount(0);
    expect(readFileSync(project.contextMd, 'utf8')).toBe(WRITTEN_BY_HAND);
    expect(statSync(project.contextMd).mtimeMs).toBe(before);
    await expect(window.locator('.onboarding-wizard')).toHaveCount(1);

    // Confirmer : les deux textes, dans l'ordre.
    await finish(window).click();
    await window.locator('.confirm-dialog-btn-confirm').click();
    await closeDoneScreen(window);
    const written = readFileSync(project.contextMd, 'utf8');
    expect(written.startsWith(WRITTEN_BY_HAND.trimEnd())).toBe(true);
    expect(written).toContain('## Research Topic');
    expect(written.indexOf('Historiographie')).toBeLessThan(written.indexOf(TOPIC));
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('un projet neuf : le gabarit se remplace sans question', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-neuf-'));

  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, parent);
    await window.locator('button[title="Nouveau projet"]').first().click();
    await window.locator('.create-project-content input[type="text"]').first().fill('Neuf');
    await window.locator('.create-project-content .path-selector button').click();
    await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);
    await window.locator('.create-project-content .btn-submit').click();
    await expect(window.locator('.onboarding-wizard__input')).toBeVisible({ timeout: 20_000 });

    await window.locator('.onboarding-wizard__input').fill(TOPIC);
    for (let step = 0; step < 3; step += 1) {
      await window.locator('.onboarding-wizard__btn', { hasText: 'Suivant' }).click();
    }
    await finish(window).click();
    await closeDoneScreen(window);
    await expect(window.locator('.confirm-dialog')).toHaveCount(0);

    const written = readFileSync(join(parent, 'Neuf', 'context.md'), 'utf8');
    expect(written.startsWith('# Neuf\n')).toBe(true);
    expect(written).toContain(TOPIC);
    expect(written).not.toContain('Décrivez ici');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test('context.md ouvert dans l’éditeur : le paragraphe des Réglages survit à la frappe suivante et à l’autosave', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(WRITTEN_BY_HAND);

  try {
    await openProject(app, window, project.projectJson);
    await window.locator('.project-file-item', { hasText: 'context.md' }).click();
    const editor = window.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Problématique');

    await openContextSettings(window);
    await typeAtEndOfZone(window, `\n${PARAGRAPH}\n`);
    await saveButton(window).click();
    await expect(window.locator('.settings-content')).toContainText('enregistré');
    await window.keyboard.press('Escape');
    await expect(window.locator('.settings-content')).toHaveCount(0);

    await expect(editor).toContainText(PARAGRAPH);
    await editor.click();
    await window.keyboard.press('ControlOrMeta+End');
    await window.keyboard.type('Une frappe.');

    // L'autosave est passé quand la frappe est sur le disque : c'est elle qu'on attend.
    await expect.poll(() => readFileSync(project.contextMd, 'utf8'), { timeout: 20_000 }).toContain('Une frappe.');
    const written = readFileSync(project.contextMd, 'utf8');
    expect(written.startsWith(WRITTEN_BY_HAND)).toBe(true);
    expect(written.indexOf('Historiographie')).toBeLessThan(written.indexOf(PARAGRAPH));

    // Cmd+Z ne ramène pas le texte d'avant l'écriture des Réglages.
    await window.keyboard.press('ControlOrMeta+z');
    await window.keyboard.press('ControlOrMeta+z');
    await expect(editor).toContainText(PARAGRAPH);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

/**
 * C38 (BT1-2) : le rechargement recréait la vue en haut du fichier. Sur un `context.md` de
 * plusieurs écrans, le paragraphe ajouté à la fin restait hors de l'écran : « l'éditeur ne montre
 * pas le nouveau paragraphe ». `toContainText` ne le voyait pas sur un fichier de sept lignes.
 */
test('long context.md ouvert et défilé en bas : le paragraphe des Réglages est à l’écran, et la frappe suivante le garde', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const long = `# Danzig\n\n${Array.from({ length: 80 }, (_, i) => `Consigne ${i + 1}.`).join('\n')}\n`;
  const project = makeProject(long);

  try {
    await openProject(app, window, project.projectJson);
    await window.locator('.project-file-item', { hasText: 'context.md' }).click();
    const editor = window.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Consigne 1.');
    await editor.click();
    await window.keyboard.press('ControlOrMeta+End');
    await expect(window.locator('.codemirror-editor .cm-line', { hasText: 'Consigne 80.' })).toBeInViewport();

    await openContextSettings(window);
    await typeAtEndOfZone(window, `\n${PARAGRAPH}\n`);
    await saveButton(window).click();
    await expect(window.locator('.settings-content')).toContainText('enregistré');
    const added = window.locator('.codemirror-editor .cm-line', { hasText: PARAGRAPH });
    await expect(added).toBeInViewport();
    // Les Paramètres sont encore ouverts : une frappe n'a pas à partir dans l'éditeur, derrière eux.
    await expect(editor).not.toBeFocused();

    await window.keyboard.press('Escape');
    await expect(window.locator('.settings-content')).toHaveCount(0);
    await expect(added).toBeInViewport();
    await added.click();
    await window.keyboard.type('Z');

    // L'autosave est passé quand la lettre est sur le disque : c'est elle qu'on attend.
    await expect.poll(() => readFileSync(project.contextMd, 'utf8'), { timeout: 20_000 }).toContain('Z');
    const written = readFileSync(project.contextMd, 'utf8');
    expect(written.startsWith(long)).toBe(true);
    expect(written).toContain(PARAGRAPH);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('modifié ailleurs depuis l’ouverture des Réglages : conflit, fichier inchangé, texte de la zone gardé', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(WRITTEN_BY_HAND);

  try {
    await openProject(app, window, project.projectJson);
    await openContextSettings(window);

    writeFileSync(project.contextMd, `${WRITTEN_BY_HAND}\nAjouté dans un autre logiciel.\n`);
    await typeAtEndOfZone(window, PARAGRAPH);
    await saveButton(window).click();

    await expect(window.locator('.settings-content [role="alert"]')).toContainText('a changé depuis');
    expect(readFileSync(project.contextMd, 'utf8')).toBe(`${WRITTEN_BY_HAND}\nAjouté dans un autre logiciel.\n`);
    await expect(contextZone(window)).toHaveValue(new RegExp(PARAGRAPH));
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

/**
 * Le faux conflit empêcherait d'enregistrer un fichier que personne n'a touché. La vraie zone de
 * texte de Chromium normalise ses fins de ligne : c'est ici qu'on le voit, pas sous jsdom.
 */
for (const [label, bytes] of [
  ['BOM', '﻿# Contexte\n\nTexte.\n'],
  ['CRLF', '# Contexte\r\n\r\nTexte.\r\n'],
  ['NFD', '# Été\n\nÉvénements.\n'.normalize('NFD')],
  ['sans saut final', '# Contexte\n\nTexte.'],
] as const) {
  test(`pas de faux conflit avec un fichier ${label}`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const project = makeProject(bytes);

    try {
      await openProject(app, window, project.projectJson);
      await window.locator('.project-file-item', { hasText: 'context.md' }).click();
      await expect(window.locator('.codemirror-editor .cm-content')).not.toContainText('Texte du manuscrit');
      // L'éditeur réécrit le fichier sans le modifier : mêmes octets, donc pas de conflit.
      await window.locator('.toolbar-btn[title="Enregistrer"]').first().click();
      await expect.poll(() => readFileSync(project.contextMd, 'utf8')).toBe(bytes);

      await openContextSettings(window);
      await typeAtEndOfZone(window, PARAGRAPH);
      await saveButton(window).click();
      await expect(window.locator('.settings-content')).toContainText('enregistré');
      const written = readFileSync(project.contextMd, 'utf8');
      expect(written.endsWith(PARAGRAPH)).toBe(true);
      expect(written.startsWith('\uFEFF')).toBe(bytes.startsWith('\uFEFF'));

      // Un second Enregistrer n'est pas un conflit non plus.
      await typeAtEndOfZone(window, ' Encore.');
      await saveButton(window).click();
      await expect.poll(() => readFileSync(project.contextMd, 'utf8')).toBe(`${written} Encore.`);
      await expect(window.locator('.settings-content [role="alert"]')).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
}

test('context.md ouvert puis supprimé dehors : l’éditeur tient le texte, donc on demande, et les deux textes restent', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(WRITTEN_BY_HAND);

  try {
    await openProject(app, window, project.projectJson);
    await window.locator('.project-file-item', { hasText: 'context.md' }).click();
    const editor = window.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Problématique');
    rmSync(project.contextMd);

    await answerQuestions(window);
    await finish(window).click();
    await expect(window.locator('.confirm-dialog-message')).toContainText('Vos réponses y seront ajoutées à la suite');
    await window.locator('.confirm-dialog-btn-confirm').click();
    await closeDoneScreen(window);

    const written = readFileSync(project.contextMd, 'utf8');
    expect(written.startsWith(WRITTEN_BY_HAND.trimEnd())).toBe(true);
    expect(written).toContain(TOPIC);
    await expect(editor).toContainText('Problématique');
    await expect(editor).toContainText(TOPIC);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('pas en UTF-8 : l’assistant et les Réglages le disent, et le fichier reste intact', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject(LATIN1);

  try {
    await openProject(app, window, project.projectJson);

    await answerQuestions(window);
    await finish(window).click();
    await expect(window.locator('.alert-dialog')).toContainText('pas encodé en UTF-8');
    await expect(window.locator('.confirm-dialog')).toHaveCount(0);
    await window.locator('.alert-dialog button').first().click();
    await expect(window.locator('.onboarding-wizard')).toHaveCount(1);
    expect(readFileSync(project.contextMd).equals(LATIN1)).toBe(true);
    await window.locator('.onboarding-wizard__close').click();

    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    });
    await window.getByRole('button', { name: 'Expert', exact: true }).click();
    await window.getByRole('button', { name: /Consignes de projet/ }).click();
    await expect(window.locator('.settings-content [role="alert"]')).toContainText('pas encodé en UTF-8');
    await expect(saveButton(window)).toBeDisabled();
    await expect(contextZone(window)).toBeDisabled();
    await expectDrawerToSay(window, 'pas encodé en UTF-8');
    expect(readFileSync(project.contextMd).equals(LATIN1)).toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
  }
});

test('lien qui sort du projet : dit tel quel, jamais pris pour un fichier à créer, et rien d’écrit dehors', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const project = makeProject();
  const outside = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dehors-'));
  const journal = join(outside, 'journal.md');
  writeFileSync(journal, 'Texte privé.');
  symlinkSync(journal, project.contextMd);

  try {
    await openProject(app, window, project.projectJson);

    await answerQuestions(window);
    await finish(window).click();
    await expect(window.locator('.alert-dialog')).toContainText('un lien qui pointe hors du projet');
    await window.locator('.alert-dialog button').first().click();
    await expect(window.locator('.onboarding-wizard')).toHaveCount(1);
    await window.locator('.onboarding-wizard__close').click();

    await window.evaluate(() => {
      window.dispatchEvent(new CustomEvent('show-settings-modal'));
    });
    await window.getByRole('button', { name: 'Expert', exact: true }).click();
    await window.getByRole('button', { name: /Consignes de projet/ }).click();
    await expect(window.locator('.settings-content [role="alert"]')).toContainText('un lien qui pointe hors du projet');
    await expect(saveButton(window)).toBeDisabled();
    await expectDrawerToSay(window, 'un lien qui pointe hors du projet');

    expect(readFileSync(journal, 'utf8')).toBe('Texte privé.');
    expect(lstatSync(project.contextMd).isSymbolicLink()).toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(project.dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
