/**
 * Un champ numérique vidé ne s'écrit plus en NaN, et un fichier déjà abîmé ne fait plus planter
 * l'app : il se répare à la lecture. Jugé sur `cliodeck-config.json`, dans un userData temporaire,
 * avec de vraies frappes et de vrais clics : c'est `blur` puis `click` que le navigateur enchaîne, et
 * `fireEvent` n'en prouve rien.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp, NO_OLLAMA } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';
import { textPdf } from './_helpers/text-pdf';

type Config = Record<string, Record<string, unknown>>;

const AUTHOR = {
  language: 'fr',
  recentProjects: [],
  rag: {
    topK: 7,
    similarityThreshold: 0.33,
    explorationSimilarityThreshold: 0.8,
    chunkingConfig: 'large',
    customChunkingEnabled: true,
    customMaxChunkSize: 600,
    useGraphContext: true,
    graphSimilarityThreshold: 0.6,
    additionalGraphDocs: 4,
  },
  llm: {
    backend: 'ollama',
    ollamaURL: NO_OLLAMA,
    ollamaEmbeddingModel: 'bge-m3',
    ollamaEmbeddingNumCtx: 4096,
    ollamaChatModel: 'qwen3:14b',
    ollamaNumCtx: 16384,
    embeddedModelPath: null,
    champInconnu: null,
  },
  editor: { fontSize: 15, theme: 'light', wordWrap: true, showMinimap: true, fontFamily: 'serif', engine: 'cm6' },
};

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userData(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-nombres-'));
  toClean.push(dir);
  writeFileSync(join(dir, 'cliodeck-config.json'), JSON.stringify(config));
  return dir;
}

const configPath = (dir: string) => join(dir, 'cliodeck-config.json');
const readConfig = (dir: string) => JSON.parse(readFileSync(configPath(dir), 'utf8')) as Config;

async function launch(dir: string, args?: string[]): Promise<{ app: ElectronApplication; window: Page } | null> {
  const outcome = await launchApp({ userDataDir: dir, args });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return null;
  }
  await expect(outcome.value.window.locator('#root')).toBeVisible({ timeout: 20_000 });
  return outcome.value;
}

async function openSettings(window: Page): Promise<void> {
  // Même événement que le raccourci du menu.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-settings-modal')));
  await expect(window.locator('#settings-modal-title')).toBeVisible({ timeout: 15_000 });
}

const section = (window: Page, name: string) =>
  window.locator('.settings-modal').getByRole('button', { name, exact: true }).click();
const expert = (window: Page) => window.locator('.settings-modal').getByRole('button', { name: 'Expert', exact: true }).click();
const number = (window: Page, attributes: string) => window.locator(`.settings-modal input[type="number"]${attributes}`);
const topK = (window: Page) => number(window, '[min="1"][max="20"]');
const threshold = (window: Page) => number(window, '[min="0"][max="1"]');
const exploration = (window: Page) => number(window, '[min="0.5"][max="0.95"]');
const save = (window: Page) => window.locator('.settings-modal button[title="Sauvegarder"]').click();
const saved = (window: Page) => window.locator('.save-message.success');
const crashed = (window: Page) => window.getByText("Quelque chose s'est mal passé");

async function openRag(window: Page): Promise<void> {
  await openSettings(window);
  await expert(window);
  await section(window, 'Configuration RAG');
  await expect(topK(window)).toBeVisible();
}

/** Remplace le contenu du champ par de vraies frappes, sans quitter le champ. */
async function typeInto(window: Page, field: ReturnType<Page['locator']>, text: string): Promise<void> {
  await field.click();
  await window.keyboard.press('ControlOrMeta+A');
  await window.keyboard.press('Backspace');
  if (text) await window.keyboard.type(text);
}

/** Échap et rouvrir : la modale démonte le panneau, le formulaire repart du disque. */
async function closeSettings(window: Page): Promise<void> {
  await window.keyboard.press('Escape');
  await expect(window.locator('#settings-modal-title')).toHaveCount(0);
}

test('le plantage décrit : deux seuils à null, la section RAG s’ouvre et montre le défaut', async () => {
  const dir = userData({
    ...AUTHOR,
    rag: { ...AUTHOR.rag, similarityThreshold: null, explorationSimilarityThreshold: null },
  });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);

    await expect(threshold(window)).toHaveValue('0.12');
    await expect(exploration(window)).toHaveValue('0.7');
    await expect(window.locator('.settings-modal').getByText('Valeur actuelle : 0.12')).toBeVisible();
    await expect(crashed(window)).toHaveCount(0);

    // Le reste de la section n'a pas bougé, et le fichier est réparé sans attendre un clic.
    expect(readConfig(dir).rag).toEqual({
      ...AUTHOR.rag,
      similarityThreshold: 0.12,
      explorationSimilarityThreshold: 0.7,
    });

    const repaired = readFileSync(configPath(dir));
    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(readFileSync(configPath(dir)).equals(repaired)).toBe(true);
  } finally {
    await app.close();
  }
});

test('le geste de la fiche : vider le seuil, Sauvegarder, fermer, rouvrir ; rien ne plante, rien n’est écrit', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    await expect(threshold(window)).toHaveValue('0.33');
    const bytes = readFileSync(configPath(dir));

    await typeInto(window, threshold(window), '');
    await save(window);
    await expect(saved(window)).toBeVisible();
    await expect(threshold(window)).toHaveValue('0.33');

    await closeSettings(window);
    await openRag(window);
    await expect(threshold(window)).toHaveValue('0.33');
    await expect(crashed(window)).toHaveCount(0);
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
  } finally {
    await app.close();
  }
});

test('un fichier sain, ouvert puis sauvegardé, champs parcourus sans rien changer : identique à l’octet', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    await section(window, 'Configuration LLM');
    await section(window, 'Éditeur');
    const bytes = readFileSync(configPath(dir));
    const mtime = statSync(configPath(dir)).mtimeMs;

    const fields = window.locator('.settings-modal input[type="number"]');
    for (let i = 0; i < (await fields.count()); i += 1) await fields.nth(i).click();

    await save(window);
    await expect(saved(window)).toBeVisible();
    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
    expect(statSync(configPath(dir)).mtimeMs).toBe(mtime);
  } finally {
    await app.close();
  }
});

test('taper une valeur et cliquer tout de suite sur Sauvegarder : la valeur est sur le disque', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    await typeInto(window, topK(window), '12');
    await expect(topK(window)).toBeFocused();

    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(readConfig(dir).rag.topK).toBe(12);
    // Le curseur jumelé et la phrase qui dit la valeur ont suivi.
    await expect(window.locator('.settings-modal .config-slider[min="1"][max="20"]')).toHaveValue('12');
  } finally {
    await app.close();
  }
});

test('la virgule française : 0,5 s’écrit 0.5', async () => {
  const dir = userData(AUTHOR);
  // La virgule suit la locale de Chromium, celle du système ou de `--lang`, pas la langue de l'app.
  const session = await launch(dir, ['--lang=fr']);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    await typeInto(window, threshold(window), '0,5');
    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(readConfig(dir).rag.similarityThreshold).toBe(0.5);
    await expect(window.locator('.settings-modal').getByText('Valeur actuelle : 0.50')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('la virgule sur un système anglais : 0,5 s’écrit 0.5, pas 1 (D21)', async () => {
  const dir = userData(AUTHOR);
  // Interface en français, Chromium en anglais : la virgule n'y est pas un séparateur décimal.
  const session = await launch(dir, ['--lang=en-US']);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    await typeInto(window, threshold(window), '0,5');
    // À la frappe : la virgule est déjà un point.
    await expect(threshold(window)).toHaveValue('0.5');
    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(readConfig(dir).rag.similarityThreshold).toBe(0.5);
    await expect(window.locator('.settings-modal').getByText('Valeur actuelle : 0.50')).toBeVisible();

    // Un champ entier n'y gagne rien : la virgule n'y devient pas un point.
    await typeInto(window, topK(window), '1,2');
    await window.keyboard.press('Enter');
    await expect(topK(window)).toHaveValue('12');
  } finally {
    await app.close();
  }
});

test('hors bornes : l’auteur voit la valeur retenue ; un entier reste entier ; Entrée valide sans rien soumettre', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    const bytes = readFileSync(configPath(dir));

    await typeInto(window, topK(window), '99');
    await window.keyboard.press('Enter');
    await expect(topK(window)).toHaveValue('20');
    await expect(topK(window)).toBeFocused();
    // Valider n'est pas enregistrer.
    await expect(saved(window)).toHaveCount(0);
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);

    await typeInto(window, topK(window), '10.7');
    await threshold(window).click();
    await expect(topK(window)).toHaveValue('10');

    await typeInto(window, threshold(window), '7');
    await topK(window).click();
    await expect(threshold(window)).toHaveValue('1');

    await save(window);
    await expect(saved(window)).toBeVisible();
    expect(readConfig(dir).rag).toMatchObject({ topK: 10, similarityThreshold: 1 });
  } finally {
    await app.close();
  }
});

test('le curseur et le champ jumelés restent d’accord, dans les deux sens', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const slider = () => window.locator('.settings-modal .config-slider[min="0"][max="1"]');

  try {
    await openRag(window);
    await slider().focus();
    await window.keyboard.press('ArrowRight');
    const moved = await slider().inputValue();
    expect(moved).not.toBe('0.33');
    await expect(threshold(window)).toHaveValue(moved);

    await typeInto(window, threshold(window), '0.6');
    await topK(window).click();
    await expect(slider()).toHaveValue('0.6');
  } finally {
    await app.close();
  }
});

test('Réinitialiser avec un brouillon en cours : le brouillon ne survit pas', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const font = () => number(window, '[max="24"]');

  try {
    await openSettings(window);
    await section(window, 'Éditeur');
    await expect(font()).toHaveValue('15');

    await typeInto(window, font(), '21');
    await window.locator('.settings-modal button[title="Réinitialiser"]').click();
    await window.locator('.confirm-dialog-btn-confirm').click();
    await expect(saved(window)).toBeVisible();

    await expect(font()).toHaveValue('14');
    expect(readConfig(dir).editor.fontSize).toBe(14);

    await font().click();
    await window.locator('.settings-modal button[title="Sauvegarder"]').click();
    await expect(saved(window)).toBeVisible();
    expect(readConfig(dir).editor.fontSize).toBe(14);
  } finally {
    await app.close();
  }
});

test('Échap ne valide pas : le brouillon part avec la fenêtre, le disque ne bouge pas', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;

  try {
    await openRag(window);
    const bytes = readFileSync(configPath(dir));
    await typeInto(window, topK(window), '3');

    await closeSettings(window);

    await openRag(window);
    await expect(topK(window)).toHaveValue('7');
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
  } finally {
    await app.close();
  }
});

test('les deux fenêtres de contexte : vide veut dire automatique, le champ quitte le fichier', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const chat = () => window.locator('.settings-modal input[placeholder="défaut du serveur (4096)"]');
  const embedding = () => window.locator('.settings-modal input[placeholder="défaut du modèle"]');

  try {
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await expect(chat()).toHaveValue('16384');
    await expect(embedding()).toHaveValue('4096');

    await typeInto(window, chat(), '');
    await typeInto(window, embedding(), '');
    await save(window);
    await expect(saved(window)).toBeVisible();

    const after = readConfig(dir).llm;
    expect(after).not.toHaveProperty('ollamaNumCtx');
    expect(after).not.toHaveProperty('ollamaEmbeddingNumCtx');
    expect(after.ollamaChatModel).toBe('qwen3:14b');
    await expect(chat()).toHaveValue('');
    await expect(embedding()).toHaveValue('');

    // Sous la borne : l'auteur voit ce qui est retenu.
    await typeInto(window, chat(), '100');
    await embedding().click();
    await expect(chat()).toHaveValue('512');
    await save(window);
    await expect.poll(() => readConfig(dir).llm.ollamaNumCtx).toBe(512);
  } finally {
    await app.close();
  }
});

// `ollama.ts` n'envoie `num_ctx` que s'il est positif. Borné à 512, ce zéro partait à chaque appel, et
// côté embeddings il tronquait le texte, donc changeait les vecteurs.
test('zéro dans une fenêtre de contexte veut dire automatique, jamais la borne de 512', async () => {
  const dir = userData(AUTHOR);
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const chat = () => window.locator('.settings-modal input[placeholder="défaut du serveur (4096)"]');
  const embedding = () => window.locator('.settings-modal input[placeholder="défaut du modèle"]');

  try {
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await expect(chat()).toHaveValue('16384');
    await expect(embedding()).toHaveValue('4096');

    await typeInto(window, chat(), '0');
    await typeInto(window, embedding(), '0');
    await expect(chat()).toHaveValue('');
    await save(window);
    await expect(saved(window)).toBeVisible();
    await expect(embedding()).toHaveValue('');

    const after = readConfig(dir).llm;
    expect(after).not.toHaveProperty('ollamaNumCtx');
    expect(after).not.toHaveProperty('ollamaEmbeddingNumCtx');
    expect(after.ollamaChatModel).toBe('qwen3:14b');

    await closeSettings(window);
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await expect(chat()).toHaveValue('');
    await expect(embedding()).toHaveValue('');
  } finally {
    await app.close();
  }
});

test('du texte illisible dans une fenêtre de contexte vide : il disparaît, le champ dit ce que dit le fichier', async () => {
  const { ollamaNumCtx: _chat, ...llm } = AUTHOR.llm;
  const dir = userData({ ...AUTHOR, llm });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const chat = () => window.locator('.settings-modal input[placeholder="défaut du serveur (4096)"]');
  const embedding = () => window.locator('.settings-modal input[placeholder="défaut du modèle"]');
  const unreadable = () => chat().evaluate((input: HTMLInputElement) => input.validity.badInput);

  try {
    await openSettings(window);
    await section(window, 'Configuration LLM');
    await expect(chat()).toHaveValue('');
    const bytes = readFileSync(configPath(dir));

    for (const text of ['e', '-']) {
      await chat().click();
      await window.keyboard.type(text);
      expect(await unreadable()).toBe(true);
      await embedding().click();
      expect(await unreadable()).toBe(false);
    }

    await chat().click();
    await window.keyboard.type('e');
    await window.keyboard.press('Enter');
    expect(await unreadable()).toBe(false);
    await expect(chat()).toBeFocused();

    await save(window);
    await expect(saved(window)).toBeVisible();
    await expect(chat()).toHaveValue('');
    expect(await unreadable()).toBe(false);
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
  } finally {
    await app.close();
  }
});

// Ce champ n'est pas un `NumberInput` : sa saisie reste immédiate pour `paramsToLose` (#196).
test('un paramètre de recette illisible : il disparaît au blur, et Lancer envoie ce que le champ montre', async () => {
  const dir = userData({ language: 'fr', recentProjects: [] });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const projectJson = article();
  const recipes = join(dirname(projectJson), '.cliodeck', 'recipes');
  mkdirSync(recipes, { recursive: true });
  writeFileSync(
    join(recipes, 'essai.yaml'),
    `name: essai
version: '1'
description: Une recette à paramètres numériques
inputs:
  n:
    type: number
    required: false
    default: 5
  r:
    type: number
    required: true
steps:
  - id: s1
    kind: brainstorm
`
  );
  const overlay = window.locator('.settings-modal .settings-modal');
  const optional = overlay.locator('input[type="number"]').nth(0);
  const required = overlay.locator('input[type="number"]').nth(1);
  const launchRecipe = overlay.getByRole('button', { name: 'Lancer' });
  const unreadable = (field: typeof optional) => field.evaluate((input: HTMLInputElement) => input.validity.badInput);

  try {
    await openProject(app, window, projectJson);
    // Le main garde ce qu'il reçoit, sans rien exécuter : c'est l'envoi qui est jugé ici.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('fusion:recipes:run');
      ipcMain.handle('fusion:recipes:run', (_event, _scope, _file, inputs) => {
        (globalThis as unknown as { e2eRecipeInputs: unknown }).e2eRecipeInputs = inputs;
        return { success: true, ok: true, outputs: {}, logPath: '/tmp/e2e.jsonl' };
      });
    });
    await openSettings(window);
    await expert(window);
    await window.getByRole('button', { name: /Recettes/ }).first().click();
    await window.locator('li', { hasText: 'essai.yaml' }).getByRole('button', { name: 'Lancer' }).click();
    await expect(optional).toHaveValue('5');

    // Un champ qui montre un nombre, puis un champ vide : là, `-` ne fait aucun `change`.
    await typeInto(window, optional, '1e');
    await required.click();
    expect(await unreadable(optional)).toBe(false);
    await expect(optional).toHaveValue('');
    await window.keyboard.type('-');
    expect(await unreadable(required)).toBe(true);
    await optional.click();
    expect(await unreadable(required)).toBe(false);
    await expect(launchRecipe).toBeDisabled();

    // Le clic retire d'abord le focus : ce que le champ montrait à ce moment est ce qui part.
    await typeInto(window, required, '3');
    await typeInto(window, optional, '1e');
    await launchRecipe.click();
    await expect.poll(() => unreadable(optional)).toBe(false);
    // L'appel traverse l'IPC : il n'est pas encore arrivé quand le clic rend la main.
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { e2eRecipeInputs: unknown }).e2eRecipeInputs))
      .toEqual({ r: 3 });
    await expect(required).toHaveValue('3');
    await expect(crashed(window)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('une section éditeur sans taille de police : 14 px dans l’éditeur, et Sauvegarder n’écrit rien', async () => {
  const dir = userData({ language: 'fr', recentProjects: [], editor: { theme: 'dark' } });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const editorFont = () =>
    window.evaluate(() => getComputedStyle(document.querySelector('.cm-editor') as Element).fontSize);

  try {
    await expect(window.locator('.cm-editor').first()).toBeVisible({ timeout: 20_000 });
    await openSettings(window);
    await section(window, 'Éditeur');
    await expect(number(window, '[max="24"]')).toHaveValue('14');
    // Le formulaire a lu la section après `App` : l'éditeur a déjà reçu ce que `App` en a tiré. Avant
    // cette lecture il montre le défaut du magasin, ce qui ne prouverait rien.
    expect(await editorFont()).toBe('14px');
    const bytes = readFileSync(configPath(dir));

    await save(window);
    await expect(saved(window)).toBeVisible();

    expect(await editorFont()).toBe('14px');
    expect(readFileSync(configPath(dir)).equals(bytes)).toBe(true);
    expect(readConfig(dir).editor).toEqual({ theme: 'dark' });
  } finally {
    await app.close();
  }
});

test('des valeurs retouchées à la main partout : l’app démarre, tout s’ouvre, seuls les nombres abîmés changent', async () => {
  const dir = userData({
    language: 'fr',
    recentProjects: [],
    rag: {
      ...AUTHOR.rag,
      topK: 'abc',
      similarityThreshold: '0.5',
      explorationSimilarityThreshold: true,
      customMaxChunkSize: [],
      customMinChunkSize: {},
      graphSimilarityThreshold: null,
      additionalGraphDocs: 'x',
      summaryMaxLength: null,
      enableQualityFiltering: true,
      minChunkEntropy: null,
    },
    llm: { ...AUTHOR.llm, ollamaNumCtx: 'abc', ollamaEmbeddingNumCtx: null },
    editor: { ...AUTHOR.editor, fontSize: null },
  });
  const session = await launch(dir);
  if (!session) return;
  const { app, window } = session;
  const errors: string[] = [];
  window.on('pageerror', (error) => errors.push(error.message));

  try {
    await expect(window.locator('.cm-editor').first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => window.evaluate(() => getComputedStyle(document.querySelector('.cm-editor') as Element).fontSize))
      .toBe('14px');

    await openRag(window);
    await section(window, 'Configuration LLM');
    await section(window, 'Éditeur');
    await expect(topK(window)).toHaveValue('10');
    await expect(threshold(window)).toHaveValue('0.12');
    await expect(exploration(window)).toHaveValue('0.7');
    await expect(number(window, '[max="24"]')).toHaveValue('14');
    await expect(crashed(window)).toHaveCount(0);
    expect(errors).toEqual([]);

    const after = readConfig(dir);
    expect(after.rag).toMatchObject({
      topK: 10,
      similarityThreshold: 0.12,
      explorationSimilarityThreshold: 0.7,
      customMaxChunkSize: 500,
      customMinChunkSize: 100,
      graphSimilarityThreshold: 0.7,
      additionalGraphDocs: 3,
      summaryMaxLength: 750,
      minChunkEntropy: 0.3,
      chunkingConfig: 'large',
    });
    expect(after.llm).not.toHaveProperty('ollamaNumCtx');
    expect(after.llm).not.toHaveProperty('ollamaEmbeddingNumCtx');
    expect(after.editor).toEqual({ ...AUTHOR.editor, fontSize: 14 });
    // Un `null` hors d'un champ numérique n'est pas une panne : il reste.
    expect(after.llm).toMatchObject({ embeddedModelPath: null, champInconnu: null, ollamaChatModel: 'qwen3:14b' });
  } finally {
    await app.close();
  }
});

function article(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-nombres-projet-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nTexte du manuscrit.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000122',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
  return projectJson;
}

/** `pdfService.init` écrit cette ligne à chaque démarrage : c'est elle qui compte les relances. */
const SERVICES_STARTED = '[PDF-SERVICE] RAG optimization config';
/** `config:set('llm')` écrit celle-ci quand il refait les fournisseurs, sans rouvrir le projet. */
const PROVIDERS_REFRESHED = 'Refreshing providers';

function watchServices(app: ElectronApplication): { started(): Promise<number>; refreshed(): number } {
  let log = '';
  let barriers = 0;
  app.process().stdout?.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  return {
    async started() {
      // Le tuyau garde l'ordre : cette ligne lue, tout ce que le main a écrit avant l'est aussi.
      barriers += 1;
      const barrier = `e2e-barriere-${barriers}`;
      await app.evaluate((_electron, line) => console.log(line), barrier);
      await expect.poll(() => log.includes(barrier)).toBe(true);
      return log.split(SERVICES_STARTED).length - 1;
    },
    // À lire après `started()`, qui pose la barrière.
    refreshed() {
      return log.split(PROVIDERS_REFRESHED).length - 1;
    },
  };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 30_000 });
}

test('topK et seuil à null : une vraie recherche rend ses sources, et réparer ne relance aucun service', async () => {
  test.setTimeout(120_000);
  const ollama = await startFakeOllama('Réponse du faux modèle.');
  toClean.push(ollama.userDataDir);
  // Les services tournent déjà quand le fichier s'abîme : ce sont eux qui lisent la réparation.
  const session = await launch(ollama.userDataDir);
  if (!session) {
    await ollama.close();
    return;
  }
  const { app, window } = session;
  const services = watchServices(app);
  const projectJson = article();
  const pdf = join(dirname(projectJson), 'source.pdf');
  textPdf(pdf, 3);
  const search = () =>
    window.evaluate(async () => {
      const found = await window.electron.pdf.search('archive document');
      return found.results.length;
    });

  try {
    await openProject(app, window, projectJson);
    const indexed = await window.evaluate(async (file) => window.electron.pdf.index(file), pdf);
    expect(indexed.success).toBe(true);
    expect(await search()).toBeGreaterThan(0);
    const started = await services.started();
    expect(started).toBeGreaterThan(0);

    // `llm` aussi : c'est la section dont l'écriture par `config:set` relance les services.
    const before = readConfig(ollama.userDataDir);
    writeFileSync(
      configPath(ollama.userDataDir),
      JSON.stringify({
        ...before,
        llm: { ...before.llm, ollamaNumCtx: 'abc' },
        rag: { topK: null, similarityThreshold: null },
      })
    );
    expect(await search()).toBeGreaterThan(0);
    await window.evaluate(() => window.electron.config.get('llm'));
    await expect.poll(() => readConfig(ollama.userDataDir).rag).toEqual({ topK: 10, similarityThreshold: 0.12 });
    expect(readConfig(ollama.userDataDir).llm).toEqual(before.llm);

    // Le témoin : une vraie écriture de `llm` qui touche un fournisseur les refait, et le compteur le
    // voit — sans rouvrir le projet (A3). Une relance venue de la réparation, même encore en cours,
    // s'ajouterait au compte des démarrages.
    const rewritten = await window.evaluate(async () => {
      const llm = await window.electron.config.get('llm');
      return window.electron.config.set('llm', { ...llm, ollamaChatModel: 'autre-modele' });
    });
    expect(rewritten.success).toBe(true);
    expect(await services.started()).toBe(started);
    expect(services.refreshed()).toBe(1);

    // Écrit tel quel par `config:set` : ni `null` sur le disque, ni zéro source après.
    const answer = await window.evaluate(async () => {
      const rag = await window.electron.config.get('rag');
      return window.electron.config.set('rag', { ...rag, topK: Number.NaN, similarityThreshold: Number.POSITIVE_INFINITY });
    });
    expect(answer.success).toBe(true);
    const rag = readConfig(ollama.userDataDir).rag;
    expect(rag).not.toHaveProperty('topK');
    expect(rag).not.toHaveProperty('similarityThreshold');
    expect(await search()).toBeGreaterThan(0);
  } finally {
    await app.close();
    await ollama.close();
  }
});

test('un fichier abîmé dès le lancement, un projet ouvert : le chat garde ses sources, l’explorateur s’ouvre', async () => {
  test.setTimeout(120_000);
  const ollama = await startFakeOllama('Réponse du faux modèle.');
  toClean.push(ollama.userDataDir);
  writeFileSync(
    configPath(ollama.userDataDir),
    JSON.stringify({
      ...readConfig(ollama.userDataDir),
      rag: { topK: null, similarityThreshold: null, explorationSimilarityThreshold: 'abc' },
    })
  );
  const session = await launch(ollama.userDataDir);
  if (!session) {
    await ollama.close();
    return;
  }
  const { app, window } = session;
  const projectJson = article();
  const pdf = join(dirname(projectJson), 'source.pdf');
  textPdf(pdf, 3);
  const toMode = (label: string) => window.locator('.workspace-mode-bar').getByRole('button', { name: label }).click();

  try {
    await openProject(app, window, projectJson);
    const indexed = await window.evaluate(async (file) => window.electron.pdf.index(file), pdf);
    expect(indexed.success).toBe(true);

    await toMode('Brainstormer');
    await window.locator('.center-panel textarea').first().fill('Que disent les archives ?');
    await window.keyboard.press('ControlOrMeta+Enter');
    await expect(window.getByRole('button', { name: 'Envoyer vers Write' }).first()).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('.brainstorm-chat__sources summary').first()).toContainText(/Sources \([1-9]/);

    // Le seuil du graphe s'y lit en `toFixed` : une chaîne venue du fichier démontait toute l'interface.
    await toMode('Explorer');
    await expect(window.getByText('0.70', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(crashed(window)).toHaveCount(0);

    expect(readConfig(ollama.userDataDir).rag).toEqual({
      topK: 10,
      similarityThreshold: 0.12,
      explorationSimilarityThreshold: 0.7,
    });
  } finally {
    await app.close();
    await ollama.close();
  }
});
