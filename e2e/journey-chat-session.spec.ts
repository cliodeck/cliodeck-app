/**
 * Un tour de chat appartient à sa session, du début à la fin (L09-6).
 *
 * Quitter l'onglet Chat pendant une génération abandonnait la réponse : la bulle restait « en
 * cours » sans fin (S16-1-0). Effacer pendant une génération n'annulait pas le tour : il continuait
 * côté main, et sa fin ôtait au tour suivant son bouton Stop (S16-1-3).
 *
 * Vrai bouton, vrai canal `fusion:chat:*`, vrai fournisseur Ollama. Un faux Ollama local tient sa
 * réponse jusqu'à ce que le test la libère : un modèle lent, sans délai à deviner.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

const FIRST = 'Début de la réponse du modèle,';
const TAIL = ' puis sa fin.';

interface Session {
  app: ElectronApplication;
  window: Page;
  ollama: FakeOllama;
}

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArticle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-chat-session-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nUn paragraphe.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000096',
      name: 'Projet E2E chat',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return projectJson;
}

async function start(): Promise<Session | null> {
  const ollama = await startFakeOllama(FIRST, { heldChat: TAIL });
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return null;
  }
  const { app, window } = outcome.value;
  const projectJson = makeArticle();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toBeVisible({ timeout: 20_000 });
  return { app, window, ollama };
}

async function stop({ app, ollama }: Session): Promise<void> {
  await app.close();
  await ollama.close();
}

const panel = (window: Page) => window.locator('.right-panel');
const chatTab = (window: Page) => panel(window).locator('#right-tab-chat');
const journalTab = (window: Page) => panel(window).locator('#right-tab-journal');
const stopButton = (window: Page) => panel(window).locator('.cancel-btn');
const answers = (window: Page) => panel(window).locator('.message-bubble.assistant');
const questions = (window: Page) => panel(window).locator('.message-bubble.user');

/** Une question au vrai chat ; le faux modèle envoie le début de sa réponse, puis attend. */
async function ask(window: Page, question: string): Promise<void> {
  await panel(window).locator('textarea').first().fill(question);
  await window.keyboard.press('ControlOrMeta+Enter');
  await expect(answers(window).last()).toContainText(FIRST, { timeout: 30_000 });
  await expect(stopButton(window)).toBeVisible();
}

test('quitter l’onglet Chat pendant la génération et revenir : la réponse continue et se termine', async () => {
  const session = await start();
  if (!session) return;
  const { window, ollama } = session;

  try {
    await chatTab(window).click();
    await ask(window, 'Parle-moi du corridor de Danzig');

    // L'onglet Journal démonte le chat ; il est remonté au retour.
    await journalTab(window).click();
    await expect(panel(window).locator('textarea')).toHaveCount(0);
    await chatTab(window).click();
    await expect(answers(window).last()).toContainText(FIRST);

    expect(ollama.releaseChat(0)).toBe(true);

    await expect(answers(window).last()).toContainText(`${FIRST}${TAIL}`, { timeout: 15_000 });
    await expect(stopButton(window)).toHaveCount(0);
    await expect(panel(window).locator('textarea').first()).toBeEnabled();
    expect(ollama.chatAborted()).toBe(0);
  } finally {
    await stop(session);
  }
});

test('Effacer pendant la génération annule le tour, et le suivant garde son bouton Stop jusqu’à sa fin', async () => {
  const session = await start();
  if (!session) return;
  const { window, ollama } = session;

  try {
    await chatTab(window).click();
    await ask(window, 'Une longue question qui part mal');

    await panel(window).locator('button[title="Effacer l\'historique"]').click();
    const confirm = window.locator('.confirm-dialog');
    await expect(confirm).toContainText('Effacer tout l');
    await confirm.locator('.confirm-dialog-btn-confirm').click();

    // Le tour effacé est coupé chez le modèle, et la conversation est vide.
    await expect.poll(() => ollama.chatAborted(), { timeout: 15_000 }).toBe(1);
    await expect(answers(window)).toHaveCount(0);
    await expect(questions(window)).toHaveCount(0);

    await ask(window, 'Une autre question');
    expect(ollama.chatRequests()).toBe(2);

    // La fin du tour effacé n'a plus personne à qui parler : le suivant garde son Stop.
    expect(ollama.releaseChat(0)).toBe(false);
    await expect(stopButton(window)).toBeVisible();
    await expect(questions(window)).toHaveCount(1);
    await expect(questions(window).first()).toContainText('Une autre question');

    expect(ollama.releaseChat(1)).toBe(true);
    await expect(answers(window).last()).toContainText(`${FIRST}${TAIL}`, { timeout: 15_000 });
    await expect(stopButton(window)).toHaveCount(0);
    await expect(answers(window)).toHaveCount(1);
  } finally {
    await stop(session);
  }
});
