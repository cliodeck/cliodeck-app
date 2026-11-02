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
