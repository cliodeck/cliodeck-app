/**
 * « Nouveau projet » ne remplace jamais rien.
 *
 * La modale écrivait ses gabarits sans regarder : le nom d'un projet existant,
 * au même emplacement, remplaçait son document.md par « # Nom », son
 * project.json et son context.md. L'assertion porte sur les octets du disque,
 * et le message doit laisser la modale ouverte pour changer de nom.
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

async function submit(window: Page, name: string): Promise<void> {
  await window.locator('.create-project-content input[type="text"]').first().fill(name);
  await window.locator('.create-project-content .btn-submit').click();
}

async function expectAlertThenClose(window: Page, text: string): Promise<void> {
  const message = window.locator('#alert-dialog-message');
  await expect(message).toContainText(text, { timeout: 15_000 });
  await window.locator('.alert-dialog-btn-ok').click();
  await expect(message).toHaveCount(0);
}

test('créer un projet sur un projet existant est refusé, et rien ne change', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;

  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));
  const dir = join(parent, 'These');
  mkdirSync(dir);
  const existing: Record<string, string> = {
    'project.json': JSON.stringify({ id: 'x', name: 'These', type: 'article', bibliographySource: { type: 'file', filePath: 'b.bib' } }),
    'document.md': '# These\n\nTrois ans de travail.\n',
    'abstract.md': 'Mon résumé.\n',
    'context.md': 'Ma problématique.\n',
  };
  for (const [file, content] of Object.entries(existing)) writeFileSync(join(dir, file), content);

  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, parent);

    await window.locator('button[title="Nouveau projet"]').first().click();
    await window.locator('.create-project-content .path-selector button').click();
    await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);

    await submit(window, 'These');
    await expectAlertThenClose(window, 'existe déjà');
    await expect(window.locator('.create-project-content')).toBeVisible();
    for (const [file, content] of Object.entries(existing)) {
      expect(readFileSync(join(dir, file), 'utf8')).toBe(content);
    }

    await submit(window, '..');
    await expectAlertThenClose(window, 'ne peut contenir');
    expect(existsSync(join(parent, 'project.json'))).toBe(false);
    expect(readdirSync(parent)).toEqual(['These']);

    // Un nom libre se crée normalement, à partir de la même modale.
    await submit(window, 'Neuf');
    await expect(window.locator('.create-project-content')).toHaveCount(0, { timeout: 20_000 });
    expect(readFileSync(join(parent, 'Neuf', 'document.md'), 'utf8')).toBe('# Neuf');
    expect(existsSync(join(parent, 'Neuf', 'project.json'))).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

/**
 * BT1-5 (C22) : après un refus au nom d'un article existant, l'auteur a vu « project.json est
 * peut-être illisible ou endommagé » pour tout projet, jusqu'au redémarrage. Le refus, Annuler,
 * puis l'article, un autre projet et l'article de nouveau : chacun s'ouvre, aucune alerte ne
 * s'affiche, et le processus principal n'inscrit aucun échec d'ouverture.
 */
test('après une création refusée, l’article, un autre projet puis l’article de nouveau s’ouvrent', async () => {
  test.setTimeout(120_000);
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  let mainLog = '';
  app.process().stdout?.on('data', (chunk: Buffer) => {
    mainLog += chunk.toString();
  });
  app.process().stderr?.on('data', (chunk: Buffer) => {
    mainLog += chunk.toString();
  });

  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-creation-'));
  const project = (name: string, text: string): { projectJson: string; documentMd: string } => {
    const dir = join(parent, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: `id-${name}`, name, type: 'article' }));
    writeFileSync(join(dir, 'document.md'), `# ${name}\n\n${text}\n`);
    return { projectJson: join(dir, 'project.json'), documentMd: join(dir, 'document.md') };
  };
  const these = project('These', 'Trois ans de travail.');
  const autre = project('Autre', 'Un deuxième projet.');
  const editor = window.locator('.codemirror-editor .cm-content');
  const noAlert = () => expect(window.locator('#alert-dialog-message')).toHaveCount(0);

  try {
    // Un chemin différent à chaque dialogue : le dossier de la création, puis chaque projet ouvert.
    await app.evaluate(({ dialog }, paths) => {
      const queue = [...paths];
      dialog.showOpenDialog = async () => {
        const next = queue.shift();
        return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
      };
    }, [parent, these.projectJson, autre.projectJson, these.projectJson]);

    await window.locator('button[title="Nouveau projet"]').first().click();
    await window.locator('.create-project-content .path-selector button').click();
    await expect(window.locator('.create-project-content .path-selector input')).toHaveValue(parent);
    await submit(window, 'These');
    await expectAlertThenClose(window, 'existe déjà');
    await window.locator('.create-project-content .btn-cancel').click();
    await expect(window.locator('.create-project-content')).toHaveCount(0);

    const openNext = async (text: string): Promise<void> => {
      await window.locator('button[title="Ouvrir un projet"]').first().click();
      await expect(editor).toContainText(text, { timeout: 20_000 });
      await expect(window.locator('.project-loading-overlay')).toHaveCount(0);
      await noAlert();
    };
    await openNext('Trois ans de travail');
    await openNext('Un deuxième projet');
    await openNext('Trois ans de travail');

    expect(readFileSync(these.documentMd, 'utf8')).toBe('# These\n\nTrois ans de travail.\n');
    expect(mainLog).not.toContain('❌ project:load error');
    expect(mainLog).not.toContain('Failed to load project');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
