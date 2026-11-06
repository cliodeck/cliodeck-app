/**
 * `.cliodeck`, ou son `brain.db`, lié hors du projet (D18), dans la vraie app : le preload, les vrais
 * handlers, les vrais services, le vrai disque, dossiers temporaires uniquement.
 *
 * Avant, tout s'ouvrait à travers le lien, écritures comprises : un `brain.db` lié vers celui d'un
 * autre projet en recevait toutes les tables (mesuré en phase 1), et un `.cliodeck` lié se
 * remplissait à l'autre bout. Désormais rien ne s'ouvre, l'historien le lit à l'écran, et son texte
 * reste éditable. Jugé sur les octets de l'autre bout.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { launchApp } from './_helpers/launch';

const VALID_CONFIG = JSON.stringify({ schema_version: 2, name: 'Autre projet' }, null, 2);

const roots: string[] = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Layout {
  projectDir: string;
  projectJson: string;
  documentMd: string;
  outside: string;
}

function makeLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-lie-'));
  roots.push(root);
  const projectDir = join(root, 'Thèse');
  const outside = join(root, 'ailleurs');
  mkdirSync(projectDir);
  mkdirSync(outside);
  const projectJson = join(projectDir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-0000000000d1',
      name: 'Thèse',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const documentMd = join(projectDir, 'document.md');
  writeFileSync(documentMd, '# Thèse\n');
  return { projectDir, projectJson, documentMd, outside };
}

/** Tout le dossier : chaque entrée, sa taille, sa date, ses octets. */
function folderState(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = join(prefix, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      out[`${rel}/`] = String(stat.mtimeMs);
      Object.assign(out, folderState(full, rel));
    } else {
      out[rel] = `${stat.size}|${stat.mtimeMs}|${readFileSync(full).toString('base64')}`;
    }
  }
  out['.'] = String(statSync(dir).mtimeMs);
  return out;
}

async function withApp(run: (app: ElectronApplication, window: Page) => Promise<void>): Promise<void> {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  try {
    await run(app, window);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** Ouvre le projet, lit le message, tape et enregistre : le texte reste à l'historien. */
async function openEditAndSave(app: ElectronApplication, window: Page, layout: Layout, linkName: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, layout.projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  const editor = window.locator('.codemirror-editor .cm-content');
  await expect(editor).toContainText(basename(layout.projectDir), { timeout: 20_000 });

  const toast = window.locator('.status-toast', { hasText: 'Dossier .cliodeck hors du projet' });
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText('reste éditable');
  // Le chemin du lien est dans les détails : l'historien sait quoi remettre en place.
  await toast.locator('.status-toast__details-btn').click();
  await expect(toast.locator('.status-toast__details')).toContainText(linkName);

  await editor.click();
  await window.keyboard.press('Meta+End');
  await window.keyboard.type('Une phrase tapée.');
  await window.locator('button.toolbar-btn[title="Enregistrer"]').first().click();
  await expect
    .poll(() => readFileSync(layout.documentMd, 'utf8'), { timeout: 10_000 })
    .toContain('Une phrase tapée.');
}

test.describe('.cliodeck lié hors du projet (D18)', () => {
  test('.cliodeck entier lié dehors : message, texte enregistré, rien d’écrit à l’autre bout', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    writeFileSync(join(layout.outside, 'config.json'), VALID_CONFIG);
    writeFileSync(join(layout.outside, 'note.txt'), 'à un autre projet');
    const link = join(layout.projectDir, '.cliodeck');
    symlinkSync(layout.outside, link);
    const before = folderState(layout.outside);

    await withApp(async (app, window) => {
      await openEditAndSave(app, window, layout, '.cliodeck');
    });

    expect(folderState(layout.outside)).toEqual(before);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('brain.db lié vers celui d’un autre projet : aucune table de ce projet n’y arrive', async () => {
    test.setTimeout(120_000);
    const layout = makeLayout();
    const otherDb = join(layout.outside, 'brain.db');
    const db = new Database(otherDb);
    db.exec("CREATE TABLE pdf_documents (id TEXT PRIMARY KEY); INSERT INTO pdf_documents VALUES ('braudel');");
    db.close();
    mkdirSync(join(layout.projectDir, '.cliodeck'));
    writeFileSync(join(layout.projectDir, '.cliodeck', 'config.json'), VALID_CONFIG);
    const link = join(layout.projectDir, '.cliodeck', 'brain.db');
    symlinkSync(otherDb, link);
    const before = folderState(layout.outside);

    await withApp(async (app, window) => {
      await openEditAndSave(app, window, layout, 'brain.db');
    });

    expect(folderState(layout.outside)).toEqual(before);
    const reader = new Database(otherDb, { readonly: true });
    const tables = reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    reader.close();
    expect(tables).toEqual([{ name: 'pdf_documents' }]);
  });
});
