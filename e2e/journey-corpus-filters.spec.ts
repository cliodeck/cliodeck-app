/**
 * Les filtres de l'explorateur de corpus, dans l'application réelle, sur le vrai graphe (canvas,
 * force-graph, d3-force).
 *
 * - Un filtre gardait les nœuds mais perdait tous les liens, « Réinitialiser filtres » compris
 *   (S13-2-1) : d3-force remplace dans les arêtes affichées les identifiants par les nœuds, et le
 *   filtre cherchait ces objets parmi des identifiants. Le pied du graphe le montre : « Liens : 0 ».
 * - Une combinaison de filtres sans document remplaçait tout le panneau, filtres compris, par
 *   « Corpus vide » (S18-1-6).
 *
 * Quatre PDF indexés par un faux Ollama, qui rend le même vecteur pour tout texte : chaque paire de
 * documents est similaire, d'où un lien de similarité par paire (6). Années et auteurs viennent des
 * métadonnées de la bibliographie.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';
import { startFakeOllama } from './_helpers/fake-ollama';
import { textPdf } from './_helpers/text-pdf';

const DOCUMENTS = [
  { file: 'ports.pdf', title: 'Ports baltes', author: 'Dupont', year: '1990' },
  { file: 'danzig.pdf', title: 'Danzig libre', author: 'Martin', year: '1990' },
  { file: 'gdansk.pdf', title: 'Gdańsk 1945', author: 'Dupont', year: '2000' },
  { file: 'ville.pdf', title: 'Ville libre', author: 'Nowak', year: '2000' },
];

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function article(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-corpus-filtres-'));
  toClean.push(dir);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeFileSync(join(dir, 'document.md'), '# Article\n\nTexte du manuscrit.\n');
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000114',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
  for (const { file } of DOCUMENTS) textPdf(join(dir, file), 2);
  return dir;
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du manuscrit', { timeout: 30_000 });
}

const footer = (window: Page, label: string) =>
  window.locator('.graph-info-item').filter({ hasText: label }).locator('.graph-info-value');
const filter = (window: Page, label: string) =>
  window.locator('.filters-container .filter-group').filter({ hasText: label }).locator('select');

test('filtrer le graphe garde les liens entre documents retenus, et un filtre vide garde les filtres', async () => {
  test.setTimeout(120_000);
  const ollama = await startFakeOllama('Réponse du faux modèle.');
  toClean.push(ollama.userDataDir);
  const outcome = await launchApp({ userDataDir: ollama.userDataDir });
  if (outcome.kind === 'skip') {
    await ollama.close();
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window } = outcome.value;
  const project = article();

  try {
    await openProject(app, window, join(project, 'project.json'));
    for (const { file, title, author, year } of DOCUMENTS) {
      const indexed = await window.evaluate(
        async ({ path, metadata }) => window.electron.pdf.index(path, undefined, metadata),
        { path: join(project, file), metadata: { title, author, year } }
      );
      expect(indexed.success).toBe(true);
    }

    await window.locator('.workspace-mode-bar').getByRole('button', { name: 'Explorer' }).click();
    await expect(footer(window, 'Nœuds:')).toHaveText('4', { timeout: 30_000 });
    await expect(footer(window, 'Liens:')).toHaveText('6');
    // Le graphe s'est affiché : d3-force a déjà remplacé les identifiants des arêtes par les nœuds.
    await expect(window.locator('.graph-visualization canvas').first()).toBeVisible();

    await window.locator('.collapsible-header').filter({ hasText: 'Filtres' }).click();
    await filter(window, 'Année:').selectOption('1990');
    await expect(footer(window, 'Nœuds:')).toHaveText('2');
    await expect(footer(window, 'Liens:')).toHaveText('1');

    await window.locator('.filters-container').getByRole('button', { name: 'Réinitialiser filtres' }).click();
    await expect(footer(window, 'Nœuds:')).toHaveText('4');
    await expect(footer(window, 'Liens:')).toHaveText('6');

    // Martin n'a rien publié en 2000 : le panneau et ses filtres restent, le message le dit.
    await filter(window, 'Année:').selectOption('2000');
    await filter(window, 'Auteur:').selectOption('Martin');
    const notice = window.locator('.corpus-no-match');
    await expect(notice).toContainText('Aucun document ne correspond aux filtres.');
    await expect(window.getByText('Corpus vide')).toHaveCount(0);
    await expect(filter(window, 'Année:')).toHaveValue('2000');
    await expect(filter(window, 'Auteur:')).toHaveValue('Martin');

    await notice.getByRole('button', { name: 'Réinitialiser filtres' }).click();
    await expect(notice).toHaveCount(0);
    await expect(footer(window, 'Nœuds:')).toHaveText('4');
    await expect(footer(window, 'Liens:')).toHaveText('6');
    await expect(filter(window, 'Année:')).toHaveValue('');
  } finally {
    await app.close();
    await ollama.close();
  }
});
