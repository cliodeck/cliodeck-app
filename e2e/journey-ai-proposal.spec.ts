/**
 * L'IA ne fait que proposer, y compris depuis un autre mode, et changer de mode ne prend ni le
 * curseur ni l'annulation.
 *
 * « Envoyer vers Write » depuis Brainstorm écrivait la réponse en fin de document, comme du texte
 * définitif : l'éditeur n'y est pas monté, et la vue remontée n'avait plus d'historique. Vrai
 * bouton, vrai chat (un faux Ollama local répond), vraie vue, vrai autosave, et **le fichier**.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

const ANSWER = 'Réponse du modèle sur le corridor de Danzig.';
const TEXT =
  '# Titre de l’article\n\nPremier paragraphe, sans histoire.\n\nDeuxième paragraphe, au milieu duquel on écrit.\n\nDernier paragraphe.\n';
const TYPED = '[FRAPPE] ';
/** « Deuxième p|aragraphe » : dix fois la flèche droite depuis le début de la ligne. */
const TYPED_TEXT = TEXT.replace('Deuxième paragraphe', `Deuxième p${TYPED}aragraphe`);
/** Plus que le délai de l'autosave : ce qui resterait à écrire le serait. */
const AUTOSAVE_MS = 4000;

interface Session {
  app: ElectronApplication;
  window: Page;
  ollama: FakeOllama;
}

const toClean: string[] = [];

function tempProject(type: 'article' | 'book', extra: Record<string, unknown> = {}): { dir: string; projectJson: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-proposition-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000044',
      name: 'Projet E2E',
      type,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    }),
  );
  return { dir, projectJson };
}

function makeArticle(text: string = TEXT): { projectJson: string; document: string } {
  const { dir, projectJson } = tempProject('article');
  const document = join(dir, 'document.md');
  writeFileSync(document, text);
  return { projectJson, document };
}

async function start(): Promise<Session | null> {
  const ollama = await startFakeOllama(ANSWER);
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return null;
  }
  return { app: outcome.value.app, window: outcome.value.window, ollama };
}

async function stop({ app, ollama }: Session): Promise<void> {
  await app.close();
  await ollama.close();
}

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const line = (window: Page, text: string) => editor(window).locator('.cm-line', { hasText: text }).first();
const proposal = (window: Page) => window.locator('.cm-proposal-box');
const proposalLine = (window: Page) => window.locator('.cm-line:has(.cm-proposal-box)').first();
const lastLine = (window: Page) => editor(window).locator('.cm-line').last();
const firstLine = (window: Page) => editor(window).locator('.cm-line').first();
const acceptProposal = (window: Page) => proposal(window).locator('button').nth(0).click();
const rejectProposal = (window: Page) => proposal(window).locator('button').nth(1).click();
const sendToWriteButton = (window: Page) => window.getByRole('button', { name: 'Envoyer vers Write' }).first();
const undo = (window: Page) => window.keyboard.press('ControlOrMeta+z');

const toMode = (window: Page, label: 'Explorer' | 'Brainstormer' | 'Écrire' | 'Exporter') =>
  window.locator('.workspace-mode-bar').getByRole('button', { name: label }).click();

/** Le curseur au milieu du 2e paragraphe, au clavier, à une position connue, puis une frappe. */
async function typeInSecondParagraph(window: Page): Promise<void> {
  await line(window, 'Deuxième paragraphe').click();
  await window.keyboard.press('Home');
  for (let i = 0; i < 10; i += 1) await window.keyboard.press('ArrowRight');
  await window.keyboard.type(TYPED);
}

/** Une vraie question au vrai chat : la réponse apporte le bouton. */
async function askChat(window: Page, zone: '.center-panel' | '.right-panel'): Promise<void> {
  await window.locator(`${zone} textarea`).first().fill('Parle-moi de Danzig');
  await window.keyboard.press('ControlOrMeta+Enter');
  await expect(sendToWriteButton(window)).toBeVisible({ timeout: 30_000 });
}

test('Écriture → Brainstorm → Écriture : le curseur revient, Cmd+Z annule la frappe, et le défilement reste', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const long = `${TEXT}\n${Array.from({ length: 200 }, (_, i) => `Remplissage ${i + 1}.\n`).join('\n')}`;
  const { projectJson, document } = makeArticle(long);

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });

    await typeInSecondParagraph(window);
    await expect.poll(() => readFileSync(document, 'utf8'), { timeout: 10_000 }).toContain(`Deuxième p${TYPED}aragraphe`);

    await toMode(window, 'Brainstormer');
    await expect(editor(window)).toHaveCount(0);
    await toMode(window, 'Écrire');

    // Le curseur : une proposition injectée sans position tombe sur lui.
    await expect(line(window, 'Deuxième p')).toBeVisible();
    await window.evaluate(() => {
      (window as unknown as { __cliodeckProposals: { inject(p: object): void } }).__cliodeckProposals.inject({
        proposed: 'INJECTÉ',
      });
    });
    await expect(proposalLine(window)).toContainText(`Deuxième p${TYPED}`);
    await expect(proposalLine(window)).toContainText('aragraphe');

    // Rejeter rend le focus à la vue : Cmd+Z y annule la frappe d'avant le changement de mode.
    await rejectProposal(window);
    await expect(proposal(window)).toHaveCount(0);
    await undo(window);
    await expect(line(window, 'Deuxième paragraphe')).not.toContainText(TYPED);
    await expect.poll(() => readFileSync(document, 'utf8'), { timeout: 10_000 }).toBe(long);

    // Le défilement : au démontage, le DOM est déjà retiré et n'en dit plus rien.
    const scroller = window.locator('.cm-scroller');
    await scroller.evaluate((el) => {
      el.scrollTop = 900;
    });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
    await toMode(window, 'Exporter');
    await expect(editor(window)).toHaveCount(0);
    await toMode(window, 'Écrire');
    await expect.poll(() => window.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  } finally {
    await stop(session);
  }
});

test('« Envoyer vers Write » depuis Brainstorm : une proposition au curseur, et le fichier n’est écrit que sur décision', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle();
  const onDisk = () => readFileSync(document, 'utf8');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });
    await typeInSecondParagraph(window);
    // L'autosave est bien actif : c'est lui qui écrit la frappe.
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TYPED_TEXT);

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    // La bascule, et rien que la proposition, là où était le curseur.
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(window.locator('.workspace-mode-bar__tab--active')).toHaveText('Écrire');
    await expect(proposal(window)).toContainText(ANSWER);
    await expect(proposalLine(window)).toContainText(`Deuxième p${TYPED}`);

    await window.waitForTimeout(AUTOSAVE_MS);
    expect(onDisk()).toBe(TYPED_TEXT);

    // Rejeter : rien ne reste, ni à l'écran ni sur le disque.
    await rejectProposal(window);
    await expect(proposal(window)).toHaveCount(0);
    await window.waitForTimeout(AUTOSAVE_MS);
    expect(onDisk()).toBe(TYPED_TEXT);

    // Une seconde fois, acceptée : le texte entre, l'autosave l'écrit, et Cmd+Z le retire seul.
    await window.locator('.right-panel #right-tab-chat').click();
    await sendToWriteButton(window).click();
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    expect(onDisk()).toBe(TYPED_TEXT);
    await acceptProposal(window);
    await expect(proposal(window)).toHaveCount(0);
    await expect(editor(window)).toContainText(ANSWER);
    await expect.poll(onDisk, { timeout: 10_000 }).toContain(ANSWER);

    await undo(window);
    await expect(editor(window)).not.toContainText(ANSWER);
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TYPED_TEXT);
  } finally {
    await stop(session);
  }
});

test('aucun curseur connu : la proposition va en fin de document, et un clic au début en fait un curseur connu', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const article = makeArticle();

  try {
    // Le document n'a jamais été affiché en Écriture depuis le lancement.
    await toMode(window, 'Brainstormer');
    await openProject(app, window, article.projectJson);
    await expect(window.locator('.status-bar')).toContainText('Projet E2E', { timeout: 20_000 });
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(lastLine(window).locator('.cm-proposal-box')).toBeVisible();
    await expect(firstLine(window).locator('.cm-proposal-box')).toHaveCount(0);
    expect(readFileSync(article.document, 'utf8')).toBe(TEXT);
    await rejectProposal(window);

    // Un autre projet, fraîchement affiché. Un clic tout au début, où le curseur est déjà, ne
    // déplace aucune sélection, mais c'est bien l'auteur qui l'a posé là.
    const otherText = '# Autre titre\n\nAutre paragraphe.\n';
    const second = makeArticle(otherText);
    await openProject(app, window, second.projectJson);
    await expect(line(window, 'Autre paragraphe')).toBeVisible({ timeout: 20_000 });
    const title = await firstLine(window).boundingBox();
    if (!title) throw new Error('Pas de première ligne');
    await window.mouse.click(title.x + 1, title.y + title.height / 2);

    // Depuis Explorer : le panneau du chat reste à l'écran, et le mode bascule.
    await toMode(window, 'Explorer');
    await window.locator('.right-panel #right-tab-chat').click();
    await expect(sendToWriteButton(window)).toBeVisible();
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(window.locator('.workspace-mode-bar__tab--active')).toHaveText('Écrire');
    await expect(firstLine(window).locator('.cm-proposal-box')).toBeVisible();
    expect(readFileSync(second.document, 'utf8')).toBe(otherText);
  } finally {
    await stop(session);
  }
});

test('livre : un brouillon proposé reste dans la file sans décision, à un changement de chapitre, et n’en sort qu’accepté', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { dir, projectJson } = tempProject('book', {
    chapters: [
      { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
      { id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
    ],
  });
  mkdirSync(join(dir, 'chapters'));
  const one = join(dir, 'chapters', '01.md');
  const two = join(dir, 'chapters', '02.md');
  writeFileSync(one, '# Un\n\nTexte du chapitre un.\n');
  writeFileSync(two, '# Deux\n\nTexte du chapitre deux.\n');
  const cards = window.locator('.drafts-panel__card');
  const insert = window.getByRole('button', { name: 'Insérer au curseur' });

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'chapitre un')).toBeVisible({ timeout: 20_000 });
    await line(window, 'chapitre un').click();
    await window.locator('.right-panel #right-tab-chat').click();
    await askChat(window, '.right-panel');
    await window.getByRole('button', { name: 'Mettre en brouillon' }).first().click();
    await window.locator('button[title="Brouillons Brainstorm"]').click();
    await expect(cards).toHaveCount(1);

    await insert.click();
    await expect(proposal(window)).toBeVisible();
    await expect(window.locator('.drafts-panel__card-actions').getByRole('button', { name: 'Proposé' })).toBeDisabled();
    // Le retrait à 600 ms, c'était le défaut.
    await window.waitForTimeout(800);
    await expect(cards).toHaveCount(1);

    await window.locator('button.chapter-item-open', { hasText: 'Deux' }).first().click();
    await expect(line(window, 'chapitre deux')).toBeVisible();
    await expect(proposal(window)).toHaveCount(0);
    await expect(cards).toHaveCount(1);
    await expect(insert).toBeEnabled();
    expect(readFileSync(one, 'utf8')).toBe('# Un\n\nTexte du chapitre un.\n');

    await insert.click();
    await expect(proposal(window)).toBeVisible();
    await acceptProposal(window);
    await expect(cards).toHaveCount(0);
    await expect.poll(() => readFileSync(two, 'utf8'), { timeout: 10_000 }).toContain(ANSWER);
  } finally {
    await stop(session);
  }
});
