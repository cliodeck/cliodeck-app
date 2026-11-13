/**
 * Une réponse coupée ne se présente plus comme complète (L09-7).
 *
 * Un runner d'Ollama qui tombe en pleine réponse envoie `{"error": …}` puis ferme le flux : la
 * réponse tronquée finissait en « stop », sans un mot (S05-1-2). Une réponse arrêtée par la limite
 * de longueur du modèle n'était signalée nulle part (S05-1-7).
 *
 * Vrai bouton, vrai canal `fusion:chat:*`, vrai fournisseur Ollama, devant un faux Ollama local.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

const FIRST = 'Début de la réponse du modèle,';
const CAUSE = 'model runner has unexpectedly stopped, this may be due to resource limitations';

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
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-chat-failure-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nUn paragraphe.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000097',
      name: 'Projet E2E panne du modèle',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return projectJson;
}

async function start(options: Parameters<typeof startFakeOllama>[1]): Promise<Session | null> {
  const ollama = await startFakeOllama(FIRST, options);
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
const answer = (window: Page) => panel(window).locator('.message-bubble.assistant').last();

async function ask(window: Page, question: string): Promise<void> {
  await panel(window).locator('#right-tab-chat').click();
  await panel(window).locator('textarea').first().fill(question);
  await window.keyboard.press('ControlOrMeta+Enter');
}

test('le modèle tombe en pleine réponse : le début reste, la cause s’affiche, rien ne se dit complet', async () => {
  const session = await start({ chatError: CAUSE });
  if (!session) return;
  const { window } = session;

  try {
    await ask(window, 'Parle-moi du corridor de Danzig');

    await expect(answer(window)).toContainText(FIRST, { timeout: 30_000 });
    await expect(answer(window).locator('.brainstorm-chat__error')).toHaveText(
      `Le modèle a échoué : ${CAUSE}`,
      { timeout: 15_000 },
    );
    await expect(answer(window).locator('.message-truncated')).toHaveCount(0);
    await expect(panel(window).locator('.cancel-btn')).toHaveCount(0);
  } finally {
    await stop(session);
  }
});

test('le modèle atteint sa limite de longueur : la réponse le dit', async () => {
  const session = await start({ doneReason: 'length' });
  if (!session) return;
  const { window } = session;

  try {
    await ask(window, 'Une synthèse très longue, s’il te plaît');

    await expect(answer(window)).toContainText(FIRST, { timeout: 30_000 });
    await expect(answer(window).locator('.message-truncated')).toHaveText(
      'Réponse tronquée : le modèle a atteint la longueur maximale de réponse.',
      { timeout: 15_000 },
    );
    await expect(answer(window).locator('.message-truncated svg.lucide')).toHaveCount(1);
    await expect(answer(window).locator('.brainstorm-chat__error')).toHaveCount(0);
  } finally {
    await stop(session);
  }
});
