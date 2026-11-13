/**
 * Le vault lié se voit dans la barre d'état, avec le nombre de ses notes indexées, et les Réglages
 * ne le disent « prêt » que s'il l'est (S17-1-10, S09-1-14).
 *
 * La barre lisait `data.noteCount` d'une réponse étalée : « Vault » ne s'affichait jamais. Et le
 * statut répondait `indexed: true` dès que `.cliodeck/brain.db` existait, ce qui arrive à
 * l'ouverture de tout projet : « Index : prêt » pour un vault jamais indexé. Après « Changer de
 * vault », les notes de l'ancien, restées dans l'index (S09-1-5), comptaient pour le nouveau.
 *
 * Le tiroir du Brainstorm distingue un vault lié mais pas encore indexé (« lancez « Indexer » »)
 * d'un projet sans vault (« liez-en un »).
 *
 * L'app réelle, des projets temporaires. L'index d'un vault se calcule par le fournisseur
 * d'embeddings, absent des tests : les notes sont écrites dans `brain.db` par le vrai magasin, comme
 * l'indexeur les écrit, avant l'ouverture du projet.
 *
 * L'indicateur MCP n'est pas vérifié ici : en rc.6, aucun client MCP ne se charge (A10), et la liste
 * des serveurs est vide dans l'app. Sa lecture est couverte par `StatusBar.test.tsx`.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { ObsidianVaultStore } from '../backend/integrations/obsidian/ObsidianVaultStore';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Un projet article ; `vault`, le dossier lié ; `notes`, celles déjà indexées dans `brain.db`, depuis
 * `indexedFrom` (par défaut le vault lié : un autre chemin, c'est un vault d'avant « Changer de vault »).
 */
function makeProject(
  root: string,
  name: string,
  vault: string | null,
  notes: string[] = [],
  indexedFrom: string | null = vault,
): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), `# ${name}\n`);
  writeFileSync(
    join(dir, '.cliodeck', 'config.json'),
    JSON.stringify({ schema_version: 2, name, ...(vault ? { vault: { path: vault } } : {}) }, null, 2),
  );
  if (notes.length > 0) {
    const store = new ObsidianVaultStore({ dbPath: join(dir, '.cliodeck', 'brain.db'), dimension: 768 });
    notes.forEach((title, i) =>
      store.upsertNote({
        id: `note-${i}`,
        relativePath: `${title}.md`,
        vaultPath: indexedFrom ?? '',
        title,
        tags: [],
        frontmatter: {},
        wikilinks: [],
        fileHash: `hash-${i}`,
        fileMtime: 0,
        indexedAt: new Date().toISOString(),
      }),
    );
    store.close();
  }
  return join(dir, 'project.json');
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string, title: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(title, { timeout: 20_000 });
}

const vaultItem = (window: Page) => window.locator('.status-bar__item', { hasText: /^Vault \d+$/ });

/** Réglages → Expert → Vault Obsidian : la ligne « Index : … ». */
async function vaultIndexLine(window: Page): Promise<string> {
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-settings-modal')));
  await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeVisible({ timeout: 15_000 });
  await window.getByRole('button', { name: 'Expert', exact: true }).click();
  await window.getByRole('button', { name: /Vault Obsidian/i }).first().click();
  const line = window.locator('div', { has: window.locator('strong', { hasText: 'Index :' }) }).last();
  await expect(line).toBeVisible();
  // Le statut se lit au montage : attendre qu'il ait répondu (le chemin du vault s'affiche).
  await expect(window.locator('code', { hasText: 'coffre' }).first()).toBeVisible({ timeout: 10_000 });
  const text = (await line.innerText()).trim();
  await window.keyboard.press('Escape');
  await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeHidden();
  return text;
}

/** Brainstormer, tiroir « Contexte du projet » : la ligne sous « Vault Obsidian ». */
async function brainstormVaultLine(window: Page): Promise<string> {
  await window.locator('.workspace-mode-bar').getByRole('button', { name: 'Brainstormer' }).click();
  await window.getByRole('button', { name: /Contexte du projet/i }).first().click();
  const section = window.locator('.brainstorm-panel__section', { has: window.locator('h3', { hasText: 'Vault Obsidian' }) });
  const line = section.locator('.brainstorm-panel__muted');
  await expect(line).not.toHaveText(/vérification/, { timeout: 10_000 });
  const text = (await line.innerText()).trim();
  await window.locator('.workspace-mode-bar').getByRole('button', { name: 'Écrire' }).click();
  return text;
}

async function withApp(run: (app: ElectronApplication, window: Page) => Promise<void>): Promise<void> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  toClean.push(userDataDir);
  try {
    await expect(window.locator('#root')).toBeVisible({ timeout: 20_000 });
    await run(app, window);
  } finally {
    await app.close();
  }
}

test('un vault lié et indexé : « Vault 3 » dans la barre d’état, « prêt » dans les Réglages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-barre-'));
  toClean.push(root);
  const vault = join(root, 'coffre');
  mkdirSync(vault);
  const projectJson = makeProject(root, 'Indexé', vault, ['Gdansk', 'Port franc', 'Sénat']);

  await withApp(async (app, window) => {
    await openProject(app, window, projectJson, 'Indexé');

    await expect(vaultItem(window)).toHaveText('Vault 3', { timeout: 15_000 });
    await expect(vaultItem(window)).toHaveAttribute('title', 'Vault : 3 notes');
    expect(await vaultIndexLine(window)).toMatch(/^Index :\s*prêt/);
  });
});

test('un vault lié jamais indexé, ou changé : « Vault 0 » et « non indexé » ; sans vault, aucun indicateur', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-barre-'));
  toClean.push(root);
  const vault = join(root, 'coffre');
  mkdirSync(vault);
  const linked = makeProject(root, 'Lié', vault);
  // « Changer de vault » : l'index garde les notes de l'ancien, qui ne sont pas celles du nouveau.
  const changed = makeProject(root, 'Changé', vault, ['Gdansk', 'Port franc'], join(root, 'ancien-coffre'));
  const bare = makeProject(root, 'Sans vault', null);

  await withApp(async (app, window) => {
    // Le projet ouvert, brain.db existe : il ne dit rien du vault.
    await openProject(app, window, linked, 'Lié');
    await expect(vaultItem(window)).toHaveText('Vault 0', { timeout: 15_000 });
    await expect(vaultItem(window)).toHaveAttribute('title', 'Vault : 0 note');
    expect(await vaultIndexLine(window)).toMatch(/^Index :\s*non indexé/);
    expect(await brainstormVaultLine(window)).toBe(
      'Vault lié, pas encore indexé — lancez « Indexer » depuis les Paramètres.',
    );

    await openProject(app, window, changed, 'Changé');
    await expect(window.locator('.status-bar')).toContainText('Changé');
    await expect(vaultItem(window)).toHaveText('Vault 0', { timeout: 15_000 });
    expect(await vaultIndexLine(window)).toMatch(/^Index :\s*non indexé/);

    await openProject(app, window, bare, 'Sans vault');
    await expect(window.locator('.status-bar')).toContainText('Sans vault');
    await expect(vaultItem(window)).toHaveCount(0);
    expect(await brainstormVaultLine(window)).toBe('Aucun vault lié — liez-en un depuis les Paramètres.');
  });
});
