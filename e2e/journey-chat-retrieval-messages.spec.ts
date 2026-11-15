/**
 * Ce que le chat dit d'une recherche en panne (H6, H5), ou d'un corpus qui s'indexe (E3).
 *
 * - Un projet sans coffre Obsidian, sans PDF ni archives, dont le modèle d'embeddings manque : chaque
 *   corpus embarquait la question avant de savoir s'il avait le moindre extrait, et le chat disait
 *   « La recherche de sources a échoué. », « Bibliographie échec · Notes (vault) échec ». Un corpus
 *   sans extrait rend 0, sans embarquer la question (H6).
 * - Ollama qui s'arrête pendant la réponse, ou avant la question : l'explication ne partait qu'à la
 *   fin d'une réponse, et la panne de recherche restait cachée derrière « Le modèle a échoué ». Elle
 *   est sous l'erreur du modèle, et sa bande nomme le corpus en panne (H5).
 * - Un premier PDF qui s'indexe : ses extraits n'entrent dans la base qu'une fois tous ses embeddings
 *   calculés, et la bibliographie, encore sans extrait, disait « 0 ». Elle dit « indexation en
 *   cours » (E3).
 *
 * Vrai bouton, vrai canal `fusion:chat:*`, vrai fournisseur Ollama, vraie recherche, devant un faux
 * Ollama local.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

const FIRST = 'Début de la réponse du modèle,';

/** Le PDF versionné du test d'extraction : deux pages de texte, « Les historiens étudient… ». */
const PDF = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'backend/core/pdf/__tests__/fixtures/extraction-fixture.pdf');

interface Session {
  app: ElectronApplication;
  window: Page;
  ollama: FakeOllama;
}

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArticle(vault?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-chat-retrieval-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  if (vault) {
    writeFileSync(
      join(dir, '.cliodeck', 'config.json'),
      JSON.stringify({ schema_version: 2, name: 'Projet E2E recherche', vault: { path: vault } }),
    );
  }
  writeFileSync(join(dir, 'document.md'), '# Article\n\nUn paragraphe.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000112',
      name: 'Projet E2E recherche',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return projectJson;
}

async function start(options: Parameters<typeof startFakeOllama>[1], vault?: string): Promise<Session | null> {
  const ollama = await startFakeOllama(FIRST, options);
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return null;
  }
  const { app, window } = outcome.value;
  const projectJson = makeArticle(vault);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  // Le texte du document, pas l'éditeur seul : l'éditeur est visible avant que le projet soit ouvert.
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Un paragraphe.', { timeout: 20_000 });
  return { app, window, ollama };
}

async function stop({ app, ollama }: Session): Promise<void> {
  await app.close();
  await ollama.close();
}

const panel = (window: Page) => window.locator('.right-panel');
const answer = (window: Page) => panel(window).locator('.message-bubble.assistant').last();

async function ask(window: Page, question: string): Promise<void> {
  await panel(window).locator('#right-tab-chat').click();
  await panel(window).locator('textarea').first().fill(question);
  await window.keyboard.press('ControlOrMeta+Enter');
}

/** Déplie « Comment cette réponse a été générée » et rend la ligne « Par corpus ». */
async function perCorpus(window: Page) {
  await answer(window).locator('.explanation-toggle').click();
  return answer(window).getByTestId('explanation-corpora');
}

test('projet sans coffre ni PDF, modèle d’embeddings absent : aucun corpus « en échec », la question n’est pas embarquée', async () => {
  const session = await start({ embedError: 'model "faux-embed" not found, try pulling it first' });
  if (!session) return;
  const { window, ollama } = session;

  try {
    const question = 'Le comité de grève des dockers de Saint-Nazaire';
    await ask(window, question);

    await expect(answer(window)).toContainText(FIRST, { timeout: 30_000 });
    const band = answer(window).locator('.retrieval-warning');
    await expect(band).toHaveText('Aucune source pertinente trouvée.', { timeout: 15_000 });
    await expect(band).toHaveAttribute('data-status', 'empty');

    const corpora = await perCorpus(window);
    await expect(corpora).toContainText('Notes (vault) 0');
    await expect(corpora).toContainText('Bibliographie 0');
    await expect(corpora).not.toContainText('échec');
    // Aucun corpus n'avait d'extrait : la question n'est jamais partie vers le modèle d'embeddings.
    expect(ollama.embeddedTexts('faux-embed').filter((text) => text.includes(question))).toEqual([]);
  } finally {
    await stop(session);
  }
});

test('Ollama s’arrête pendant la réponse : l’explication reste sous l’erreur du modèle', async () => {
  const session = await start({ heldChat: ' et la suite qui ne viendra jamais.' });
  if (!session) return;
  const { window, ollama } = session;

  try {
    await ask(window, 'Parle-moi du corridor de Danzig');
    await expect(answer(window)).toContainText(FIRST, { timeout: 30_000 });
    await expect.poll(() => ollama.chatRequests(), { timeout: 15_000 }).toBe(1);

    // Ollama s'arrête : la réponse en cours est coupée net.
    await ollama.close();

    await expect(answer(window).locator('.brainstorm-chat__error')).toBeVisible({ timeout: 15_000 });
    await expect(answer(window).locator('.explanation-toggle')).toHaveText('Comment cette réponse a été produite');
    await expect(answer(window)).toContainText(FIRST);
  } finally {
    await stop(session);
  }
});

test('Ollama arrêté avant la question, coffre indexé : la bande nomme le coffre en panne, sous l’erreur du modèle', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-chat-retrieval-vault-'));
  toClean.push(vault);
  writeFileSync(join(vault, 'comite.md'), '# Comité de grève\n\nLe comité de grève des dockers, réuni le 3 avril 1907.\n');
  const session = await start({}, vault);
  if (!session) return;
  const { window, ollama } = session;

  try {
    // Le canal du bouton « Indexer » des Réglages, avec Ollama en marche.
    const indexed = await window.evaluate(() => window.electron.fusion.vault.index({}));
    expect(indexed).toMatchObject({ success: true });

    await ollama.close();
    await ask(window, 'Que disent mes notes du comité de grève ?');

    await expect(answer(window).locator('.brainstorm-chat__error')).toContainText('Le modèle a échoué', {
      timeout: 30_000,
    });
    const band = answer(window).locator('.retrieval-warning');
    await expect(band).toContainText('Corpus en échec :');
    await expect(band).toContainText('Notes (vault)');
    await expect(band).not.toContainText('Bibliographie');
    await expect(band).toHaveAttribute('data-status', 'failed');

    const corpora = await perCorpus(window);
    await expect(corpora).toContainText('Notes (vault) échec');
    await expect(corpora).toContainText('Bibliographie 0');
  } finally {
    await stop(session);
  }
});

test('premier PDF en cours d’indexation : la bibliographie dit « indexation en cours », ni « 0 » ni « échec »', async () => {
  // Les embeddings restent sans réponse, comme un Ollama lent : l'indexation du PDF ne finit pas.
  const session = await start({ hangEmbed: true });
  if (!session) return;
  const { app, window, ollama } = session;
  const ofPdf = () => ollama.embedRequests().filter((request) => request.texts.some((text) => /historiens|seconde page/.test(text)));

  try {
    // Le canal des boutons « Indexer » de la bibliographie, sans attendre sa fin.
    await window.evaluate((filePath) => {
      void window.electron.pdf.index(filePath);
    }, PDF);
    // Extrait, découpé : ses embeddings sont partis, aucun extrait n'est encore dans la base.
    await expect.poll(() => ofPdf().length, { timeout: 30_000 }).toBeGreaterThan(0);

    const question = 'Que disent mes PDF des fichiers officiels ?';
    await ask(window, question);
    await expect(answer(window)).toContainText(FIRST, { timeout: 30_000 });

    const band = answer(window).locator('.retrieval-warning');
    await expect(band).toContainText('Corpus en cours d’indexation, pas encore interrogé : Bibliographie.', {
      timeout: 15_000,
    });
    await expect(band).not.toContainText('échou');
    const corpora = await perCorpus(window);
    await expect(corpora).toContainText('Bibliographie indexation en cours');
    await expect(corpora).not.toContainText('échec');
    // La bibliographie n'avait encore rien à chercher : la question n'est pas embarquée.
    expect(ollama.embedRequests().filter((request) => request.texts.some((text) => text.includes(question)))).toEqual([]);
  } finally {
    // Ollama d'abord : ses embeddings retenus échouent, l'indexation finit, et l'app quitte sans
    // attendre le délai de fermeture.
    await ollama.close();
    await app.close();
  }
});
