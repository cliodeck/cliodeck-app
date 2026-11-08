/**
 * L'IA ne fait que proposer, y compris depuis un autre mode, et changer de mode ne prend ni le
 * curseur ni l'annulation.
 *
 * « Envoyer vers Write » depuis Brainstorm écrivait la réponse en fin de document, comme du texte
 * définitif : l'éditeur n'y est pas monté, et la vue remontée n'avait plus d'historique. Vrai
 * bouton, vrai chat (un faux Ollama local répond), vraie vue, vrai autosave, et **le fichier**.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
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

function tempProject(type: 'article' | 'book' | 'presentation', extra: Record<string, unknown> = {}): { dir: string; projectJson: string } {
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

/**
 * Une trentaine de paragraphes, comme en rend un vrai modèle local. Une phrase ne montrait pas que
 * les boutons, au bout de l'encart, tombaient sous le bas de l'écran (C33 à C35).
 */
const LONG_ANSWER = Array.from(
  { length: 30 },
  (_, i) => `Paragraphe ${i + 1} de la réponse du modèle, sur le corridor de Danzig et ce qu’il faut pour remplir plus d’une ligne de l’éditeur.`,
).join('\n\n');

async function start(options: { answer?: string; wordWrap?: false } = {}): Promise<Session | null> {
  const ollama = await startFakeOllama(options.answer ?? ANSWER);
  toClean.push(ollama.userDataDir);
  if (options.wordWrap === false) {
    // Le réglage « Retour à la ligne », lu au démarrage comme celui de l'auteur.
    const configPath = join(ollama.userDataDir, 'cliodeck-config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, editor: { wordWrap: false } }));
  }
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

const LONG_DOCUMENT = `# Long document\n\n${Array.from(
  { length: 400 },
  (_, i) => `Paragraphe numéro ${i + 1}, avec assez de texte pour remplir la ligne et faire défiler l’éditeur.\n`,
).join('\n')}`;

const scrollTop = (window: Page) => window.locator('.cm-scroller').evaluate((el) => el.scrollTop);

/** L'auteur fait défiler, sans cliquer : ce qu'il lit n'est pas là où est son curseur. */
async function scrollAway(window: Page): Promise<void> {
  await window.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = 6000;
  });
  await expect.poll(() => scrollTop(window)).toBeGreaterThan(5000);
}

/**
 * Dans la zone visible de l'éditeur. `toBeVisible` ne le dit pas : une proposition hors écran reste
 * rendue, et le défilement restauré n'arrive qu'à l'image suivante. On laisse donc passer deux
 * images avant de regarder.
 */
async function expectOnScreen(window: Page, target: Locator): Promise<void> {
  await window.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect
    .poll(() =>
      target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const zone = (el.closest('.cm-scroller') as Element).getBoundingClientRect();
        return box.top < zone.bottom && box.bottom > zone.top;
      }),
    )
    .toBe(true);
}

/** Le bouton Accepter de la proposition, par son nom accessible, raccourci compris. */
const acceptButton = (window: Page) => proposal(window).getByRole('button', { name: 'Accepter la proposition (Tab)' });

/**
 * Tout entier dans la zone visible de l'éditeur, sur les deux axes : sans retour à la ligne, un
 * bouton peut être à la bonne hauteur et hors de l'écran à droite. Barres de défilement exclues.
 */
async function expectWhollyOnScreen(window: Page, target: Locator): Promise<void> {
  await window.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect
    .poll(() =>
      target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const scroller = el.closest('.cm-scroller') as HTMLElement;
        const zone = scroller.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.left >= zone.left &&
          box.right <= zone.left + scroller.clientWidth &&
          box.top >= zone.top &&
          box.bottom <= zone.top + scroller.clientHeight
        );
      }),
    )
    .toBe(true);
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

test('retour par l’onglet, sans cliquer : Cmd+Z annule la frappe, la suivante entre au curseur, et le clavier n’est pas piégé', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle();
  const onDisk = () => readFileSync(document, 'utf8');
  const contentHasFocus = () => editor(window).evaluate((el) => el === el.ownerDocument.activeElement);

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });
    await typeInSecondParagraph(window);
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TYPED_TEXT);

    await toMode(window, 'Brainstormer');
    await expect(editor(window)).toHaveCount(0);
    await toMode(window, 'Écrire');
    await expect.poll(contentHasFocus).toBe(true);

    await undo(window);
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TEXT);
    await window.keyboard.type('X');
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TEXT.replace('Deuxième paragraphe', 'Deuxième pXaragraphe'));

    // Au clavier : Entrée sur l'onglet donne le focus au texte sans y poser de saut de ligne, et
    // Maj+Tab en ressort.
    const written = onDisk();
    await toMode(window, 'Exporter');
    await expect(editor(window)).toHaveCount(0);
    await window.locator('.workspace-mode-bar__tab', { hasText: 'Écrire' }).focus();
    await window.keyboard.press('Enter');
    await expect.poll(contentHasFocus).toBe(true);
    await window.keyboard.press('Shift+Tab');
    await expect.poll(contentHasFocus).toBe(false);
    await window.waitForTimeout(AUTOSAVE_MS);
    expect(onDisk()).toBe(written);
  } finally {
    await stop(session);
  }
});

test('curseur en fin de phrase : il reste à sa place, et après un rejet la frappe suivante reste dans le paragraphe', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle();
  const onDisk = () => readFileSync(document, 'utf8');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });
    await line(window, 'Deuxième paragraphe').click();
    await window.keyboard.press('End');

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(proposalLine(window)).toContainText('au milieu duquel on écrit.');

    await window.keyboard.press('Escape');
    await expect(proposal(window)).toHaveCount(0);
    expect(onDisk()).toBe(TEXT);

    await window.keyboard.type('SUITE');
    await expect
      .poll(onDisk, { timeout: 10_000 })
      .toBe(TEXT.replace('au milieu duquel on écrit.', 'au milieu duquel on écrit.SUITE'));
  } finally {
    await stop(session);
  }
});

test('présentation, curseur en fin de diapositive : le navigateur n’en change pas pendant l’attente, et le séparateur tient', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { dir, projectJson } = tempProject('presentation');
  const slides = join(dir, 'slides.md');
  const deck = Array.from({ length: 6 }, (_, i) => `# Diapo ${i + 1}\n\nTexte de la diapo ${i + 1}.\n`).join('\n---\n\n');
  writeFileSync(slides, deck);
  const activeSlide = window.locator('.slide-navigator-item.active');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Texte de la diapo 5')).toBeVisible({ timeout: 20_000 });
    await line(window, 'Texte de la diapo 5').click();
    await window.keyboard.press('End');
    await expect(activeSlide).toContainText('Diapo 5');

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(activeSlide).toContainText('Diapo 5');

    await window.keyboard.press('Escape');
    await expect(proposal(window)).toHaveCount(0);
    await window.keyboard.type('Suite de mon idée');
    await expect
      .poll(() => readFileSync(slides, 'utf8'), { timeout: 10_000 })
      .toBe(deck.replace('Texte de la diapo 5.', 'Texte de la diapo 5.Suite de mon idée'));
    await expect(window.locator('.slide-navigator-item')).toHaveCount(6);
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

test('l’auteur lisait loin de son curseur : la proposition arrive à l’écran, à son curseur', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle(LONG_DOCUMENT);

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Paragraphe numéro 2,')).toBeVisible({ timeout: 20_000 });
    await line(window, 'Paragraphe numéro 2,').click();
    await scrollAway(window);

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(proposalLine(window)).toContainText('Paragraphe numéro 2,');
    await expectOnScreen(window, proposal(window));
    expect(readFileSync(document, 'utf8')).toBe(LONG_DOCUMENT);
  } finally {
    await stop(session);
  }
});

test('l’auteur lisait sans avoir cliqué : la proposition arrive à l’écran, en fin de document', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle(LONG_DOCUMENT);

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Paragraphe numéro 2,')).toBeVisible({ timeout: 20_000 });
    await scrollAway(window);

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(lastLine(window).locator('.cm-proposal-box')).toBeVisible();
    await expectOnScreen(window, proposal(window));
    expect(readFileSync(document, 'utf8')).toBe(LONG_DOCUMENT);
  } finally {
    await stop(session);
  }
});

test('une longue réponse au milieu d’un paragraphe : Accepter est à l’écran, avec son libellé ; Échap ne laisse rien, et Cmd+Z retire le texte accepté', async () => {
  const session = await start({ answer: LONG_ANSWER });
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle();
  const onDisk = () => readFileSync(document, 'utf8');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });
    // C33 : le curseur au milieu du 2e paragraphe.
    await line(window, 'Deuxième paragraphe').click();
    await window.keyboard.press('Home');
    for (let i = 0; i < 10; i += 1) await window.keyboard.press('ArrowRight');

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(proposal(window)).toContainText('Paragraphe 30 de la réponse');
    await expectWhollyOnScreen(window, acceptButton(window));
    await expect(acceptButton(window)).toHaveText('Accepter');
    expect(onDisk()).toBe(TEXT);

    // C34 : Échap ne laisse rien, ni à l'écran ni sur le disque.
    await window.keyboard.press('Escape');
    await expect(proposal(window)).toHaveCount(0);
    await window.waitForTimeout(AUTOSAVE_MS);
    expect(onDisk()).toBe(TEXT);

    // Une seconde fois, acceptée : le texte entre, et Cmd+Z le retire.
    await window.locator('.right-panel #right-tab-chat').click();
    await sendToWriteButton(window).click();
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expectWhollyOnScreen(window, acceptButton(window));
    await acceptButton(window).click();
    await expect(proposal(window)).toHaveCount(0);
    await expect.poll(onDisk, { timeout: 10_000 }).toContain('Paragraphe 30 de la réponse');

    await undo(window);
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(TEXT);
  } finally {
    await stop(session);
  }
});

test('C35, une longue réponse alors que l’auteur lisait loin de son curseur : Accepter arrive à l’écran', async () => {
  const session = await start({ answer: LONG_ANSWER });
  if (!session) return;
  const { app, window } = session;
  const { projectJson, document } = makeArticle(LONG_DOCUMENT);
  const scroller = window.locator('.cm-scroller');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Paragraphe numéro 2,')).toBeVisible({ timeout: 20_000 });
    // Le curseur au fil du document, loin du début : la proposition a de la place au-dessus d'elle.
    await scroller.evaluate((el) => {
      el.scrollTop = 8000;
    });
    await expect.poll(() => scrollTop(window)).toBeGreaterThan(7000);
    // Le premier paragraphe sous le milieu de l'écran, une fois les lignes de cet endroit rendues :
    // un clic au milieu tomberait parfois sur une ligne vide.
    let cursorParagraph = '';
    await expect
      .poll(async () => {
        cursorParagraph = await scroller.evaluate((el) => {
          const middle = (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2;
          const below = [...el.querySelectorAll('.cm-line')].find(
            (l) => l.textContent?.startsWith('Paragraphe numéro') && l.getBoundingClientRect().top > middle,
          );
          return below?.textContent?.match(/^Paragraphe numéro \d+,/)?.[0] ?? '';
        });
        return cursorParagraph;
      })
      .not.toBe('');
    await line(window, cursorParagraph).click();
    // Puis l'auteur remonte lire le début.
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => scrollTop(window)).toBe(0);

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(proposalLine(window)).toContainText(cursorParagraph);
    await expectWhollyOnScreen(window, acceptButton(window));
    expect(readFileSync(document, 'utf8')).toBe(LONG_DOCUMENT);
  } finally {
    await stop(session);
  }
});

test('sans retour à la ligne, une longue réponse au milieu d’une longue ligne : Accepter est à l’écran, aussi en largeur', async () => {
  const session = await start({ answer: LONG_ANSWER, wordWrap: false });
  if (!session) return;
  const { app, window } = session;
  const text = TEXT.replace(
    'Deuxième paragraphe, au milieu duquel on écrit.',
    `Deuxième paragraphe, ${'une phrase qui ne finit pas, '.repeat(40)}et sa fin.`,
  );
  const { projectJson, document } = makeArticle(text);

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Deuxième paragraphe')).toBeVisible({ timeout: 20_000 });
    await line(window, 'Deuxième paragraphe').click();
    await window.keyboard.press('End');
    for (let i = 0; i < 20; i += 1) await window.keyboard.press('ArrowLeft');
    // Le réglage a bien pris : la ligne ne revient pas à la ligne, l'éditeur a défilé en largeur.
    await expect.poll(() => window.locator('.cm-scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();

    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    await expect(proposalLine(window)).toContainText('et sa fin.');
    await expectWhollyOnScreen(window, acceptButton(window));
    expect(readFileSync(document, 'utf8')).toBe(text);
  } finally {
    await stop(session);
  }
});

test('un fichier CRLF garde ses fins de ligne : rien n’est écrit sans décision, puis aucun LF nu', async () => {
  const session = await start();
  if (!session) return;
  const { app, window } = session;
  const crlf = TEXT.replace(/\n/g, '\r\n');
  const { projectJson, document } = makeArticle(crlf);
  const onDisk = () => readFileSync(document, 'utf8');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Premier paragraphe')).toBeVisible({ timeout: 20_000 });
    await line(window, 'Premier paragraphe').click();
    await window.keyboard.press('End');

    await toMode(window, 'Brainstormer');
    await askChat(window, '.center-panel');
    await sendToWriteButton(window).click();
    await expect(proposal(window)).toBeVisible({ timeout: 8_000 });
    expect(onDisk()).toBe(crlf);

    await acceptProposal(window);
    await expect.poll(onDisk, { timeout: 10_000 }).toContain(ANSWER);
    const written = onDisk();
    // Tout au même format, et le texte accepté en bloc entre « Premier » et « Deuxième ».
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(written).toMatch(/sans histoire\.\r\n\r\n<!-- cliodeck:brainstorm-draft/);
    expect(written).toContain('<!-- /cliodeck:brainstorm-draft -->\r\n\r\nDeuxième paragraphe');

    await undo(window);
    await expect.poll(onDisk, { timeout: 10_000 }).toBe(crlf);
  } finally {
    await stop(session);
  }
});

test('« Ouvrir la source » vers un chapitre déjà visité : le passage est à l’écran, pas l’ancienne position', async () => {
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
  writeFileSync(join(dir, 'chapters', '01.md'), '# Un\n\nCourt.\n');
  const segments = Array.from(
    { length: 40 },
    (_, i) => `Segment numéro ${i + 1}, sur le corridor de Danzig et ce qu’il faut pour remplir la ligne.\n`,
  ).join('\n');
  writeFileSync(
    join(dir, 'chapters', '02.md'),
    `# Deux\n\n${Array.from({ length: 10 }, (_, k) => `## Section ${k + 1}\n\n${segments}`).join('\n')}`,
  );
  const chapter = (title: string) => window.locator('button.chapter-item-open', { hasText: title }).first();
  const snippets = window.locator('.brainstorm-chat__source-snippet');
  const popover = window.locator('.source-popover');

  try {
    await openProject(app, window, projectJson);
    await expect(line(window, 'Court')).toBeVisible({ timeout: 20_000 });
    // Visité une fois, sans défiler : son état mémorisé porte un défilement à 0.
    await chapter('Deux').click();
    await expect(line(window, 'Segment numéro 1,')).toBeVisible();
    await chapter('Un').click();
    await expect(line(window, 'Court')).toBeVisible();

    await window.evaluate(() =>
      (window as unknown as { electron: { manuscript: { index(): Promise<unknown> } } }).electron.manuscript.index(),
    );

    await toMode(window, 'Brainstormer');
    await window.locator('.center-panel textarea').first().fill('Qu’ai-je déjà écrit sur le corridor de Danzig ?');
    await window.keyboard.press('ControlOrMeta+Enter');
    await expect(sendToWriteButton(window)).toBeVisible({ timeout: 30_000 });
    await window.locator('.brainstorm-chat__sources summary').first().click();

    // L'extrait le plus loin dans le chapitre Deux.
    let farthest = -1;
    let farthestLine = 0;
    for (let i = 0; i < (await snippets.count()); i += 1) {
      await snippets.nth(i).click();
      const match = (await popover.innerText()).match(/02\.md · L(\d+)/);
      if (match && Number(match[1]) > farthestLine) {
        farthest = i;
        farthestLine = Number(match[1]);
      }
      await snippets.nth(i).click();
      await expect(popover).toHaveCount(0);
    }
    expect(farthestLine).toBeGreaterThan(40);

    await snippets.nth(farthest).click();
    await window.getByRole('button', { name: 'Ouvrir la source' }).click();

    await expect(window.locator('.workspace-mode-bar__tab--active')).toHaveText('Écrire');
    await expect(line(window, 'Segment numéro')).toBeVisible();
    await expectOnScreen(window, window.locator('.cm-cursorLayer .cm-cursor').first());
    expect(await scrollTop(window)).toBeGreaterThan(0);
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
