/**
 * Une demande d'embedding sans réponse s'abandonne (J9).
 *
 * L'embedding de la question ne revient pas — Ollama qui charge un modèle d'embeddings sans fin. Le
 * bouton « Arrêter » fermait la bulle, mais la requête restait ouverte jusqu'au redémarrage de l'app,
 * et la fermeture du projet ne la coupait pas non plus : la connexion à Ollama n'a pas de délai.
 *
 * Vrai bouton, vrai canal `fusion:chat:*`, vrai fournisseur Ollama, vraie recherche. Un faux Ollama
 * local ne répond jamais sur `/api/embed`, et voit chaque demande que l'app coupe.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama, type FakeOllama } from './_helpers/fake-ollama';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeArticle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-embed-stop-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nUn paragraphe.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000109',
      name: 'Projet E2E embedding',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return projectJson;
}

const panel = (window: Page) => window.locator('.right-panel');
const stopButton = (window: Page) => panel(window).locator('.cancel-btn');
const answers = (window: Page) => panel(window).locator('.message-bubble.assistant');

/** Les demandes d'embedding qui portent ce texte. */
const requestsFor = (ollama: FakeOllama, text: string) =>
  ollama.embedRequests().filter((r) => r.texts.some((t) => t.includes(text)));

test('« Arrêter » pendant l’embedding de la question coupe sa requête ; fermer le projet coupe les autres', async () => {
  const ollama = await startFakeOllama('jamais envoyée', { hangEmbed: true });
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window }: { app: ElectronApplication; window: Page } = outcome.value;

  try {
    const projectJson = makeArticle();
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(window.locator('.codemirror-editor .cm-content')).toBeVisible({ timeout: 20_000 });

    const question = 'Le corridor de Danzig en 1939';
    await panel(window).locator('#right-tab-chat').click();
    await panel(window).locator('textarea').first().fill(question);
    await window.keyboard.press('ControlOrMeta+Enter');

    // La recherche embarque la question ; le faux Ollama ne répond pas.
    await expect.poll(() => requestsFor(ollama, question).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(stopButton(window)).toBeVisible();
    expect(ollama.chatRequests()).toBe(0);

    await stopButton(window).click();

    // La bulle se ferme, et chaque requête d'embedding de la question est coupée chez Ollama.
    await expect(stopButton(window)).toHaveCount(0);
    await expect(panel(window).locator('textarea').first()).toBeEnabled();
    await expect
      .poll(() => requestsFor(ollama, question).every((r) => r.aborted), { timeout: 15_000 })
      .toBe(true);
    // Le modèle n'a rien reçu : le tour s'est arrêté avant lui.
    expect(ollama.chatRequests()).toBe(0);
    await expect(answers(window).last()).not.toContainText(/échec|échoué/i);

    // Les autres demandes du projet (préchauffage) attendent toujours ; fermer le projet les coupe.
    expect(ollama.embedRequests().length).toBeGreaterThan(requestsFor(ollama, question).length);
    await window.locator('#left-tab-projects').click();
    await window.getByRole('button', { name: 'Fermer le projet' }).click();
    await expect
      .poll(() => ollama.embedRequests().filter((r) => !r.aborted).map((r) => r.texts[0]), { timeout: 30_000 })
      .toEqual([]);
  } finally {
    await app.close();
    await ollama.close();
  }
});
