/**
 * Un chapitre en lien symbolique, dans la vraie app (décision Q16).
 *
 * Un projet reçu par git ou en zip garde ses liens : un chapitre peut pointer vers un
 * fichier de l'auteur. Il est marqué manquant, ni lu ni indexé ; un lien qui reste dans
 * le projet continue de marcher. Le risque de ce contrôle est le faux positif : un projet
 * ouvert par un chemin qui passe lui-même par un lien ne doit rien perdre. Le dossier
 * temporaire de macOS en est déjà un, et ce parcours en ajoute un second.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const SECRET = 'SECRET-HORS-PROJET';

interface LinkedBook {
  base: string;
  /** Le dossier réel du projet. */
  real: string;
  /** Le chemin par lequel l'app l'ouvre. */
  alias: string;
  outside: string;
}

function makeLinkedBook(): LinkedBook {
  const base = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-lien-'));
  const real = join(base, 'projet-reel');
  const alias = join(base, 'projet-par-un-lien');
  const outside = join(base, 'dehors');
  mkdirSync(join(real, 'chapters'), { recursive: true });
  mkdirSync(join(real, '.cliodeck'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'journal.md'), `# ${SECRET}\n\nTexte privé.\n`);
  writeFileSync(join(real, 'chapters', '01-un.md'), '# Un\n\nTexte du premier chapitre.\n');
  writeFileSync(join(real, 'chapters', '03-relie.md'), '# Relié\n\nTexte du fichier relié.\n');
  // Sortant, puis interne.
  symlinkSync(join(outside, 'journal.md'), join(real, 'chapters', '02-annexe.md'));
  symlinkSync('03-relie.md', join(real, 'chapters', '04-copie.md'));
  writeFileSync(
    join(real, 'project.json'),
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000012',
      name: 'Livre lié',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [
        { id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Annexe', filePath: 'chapters/02-annexe.md', order: 1, kind: 'chapter' },
        { id: 'c3', title: 'Copie', filePath: 'chapters/04-copie.md', order: 2, kind: 'chapter' },
      ],
    }),
  );
  symlinkSync(real, alias);
  return { base, real, alias, outside };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const chapterButton = (window: Page, title: string) =>
  window.locator('button.chapter-item-open', { hasText: title }).first();

interface Reachable {
  loaded: { success: boolean; code?: string; reason?: string; content?: string };
  read: { files: Array<{ filePath: string; content?: string; reason?: string }> };
  fsRead: string | null;
}

/** Ce que le renderer obtient du main en demandant le fichier par ses canaux. */
const askMainFor = (window: Page, projectPath: string, relPath: string): Promise<Reachable> =>
  window.evaluate(
    async ({ projectPath: root, relPath: rel }) => {
      const api = (window as unknown as { electron: {
        editor: { loadFile: (p: string) => Promise<Reachable['loaded']> };
        project: { readChapters: (d: { projectPath: string; filePaths: string[] }) => Promise<Reachable['read']> };
        fs: { readFile: (p: string) => Promise<string> };
      } }).electron;
      return {
        loaded: await api.editor.loadFile(`${root}/${rel}`),
        read: await api.project.readChapters({ projectPath: root, filePaths: [rel] }),
        fsRead: await api.fs.readFile(`${root}/${rel}`).catch(() => null),
      };
    },
    { projectPath, relPath },
  );

test('projet ouvert par un lien : rien de manquant à tort, et le chapitre sortant reste fermé', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeLinkedBook();

  try {
    await openProject(app, window, join(book.alias, 'project.json'));
    // Le premier chapitre présent s'ouvre, par le chemin en lien.
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });
    await expect(window.locator('button.chapter-item-open')).toHaveCount(3);

    // Le faux positif : ni le chapitre ordinaire, ni le lien interne ne sont manquants.
    await expect(chapterButton(window, 'Un')).toBeEnabled();
    await expect(chapterButton(window, 'Copie')).toBeEnabled();

    // Le lien sortant : fermé, et la raison se lit au survol.
    const annexe = chapterButton(window, 'Annexe');
    await expect(annexe).toBeDisabled();
    await expect(annexe).toHaveAttribute('title', /lien qui sort du projet/);
    await expect(annexe).toHaveAttribute('title', /chapters\/02-annexe\.md/);
    await expect(annexe).not.toHaveAttribute('title', /introuvable/);

    // Le lien interne s'ouvre, et s'enregistre dans son fichier réel.
    await chapterButton(window, 'Copie').click();
    await expect(editor(window)).toContainText('Texte du fichier relié');

    // Aucun canal du main ne lit la cible du lien sortant.
    const reached = await askMainFor(window, book.alias, 'chapters/02-annexe.md');
    expect(reached.loaded).toMatchObject({ success: false, code: 'unreadable', reason: 'refused' });
    expect(reached.read.files[0]).toMatchObject({ reason: 'refused' });
    expect(reached.fsRead).toBeNull();
    expect(JSON.stringify(reached)).not.toContain(SECRET);

    // Réorganiser garde la ligne du manifeste, et le chapitre reste fermé.
    const row = window.locator('li.chapter-item', { hasText: 'Annexe' });
    await row.hover();
    await row.locator('button[title="Déplacer vers le haut"]').click();
    await expect(window.locator('button.chapter-item-open').first()).toContainText('Annexe');
    await expect(chapterButton(window, 'Annexe')).toBeDisabled();
    await expect
      .poll(() => JSON.parse(readFileSync(join(book.real, 'project.json'), 'utf8')).chapters[0])
      .toEqual({ id: 'c2', title: 'Annexe', filePath: 'chapters/02-annexe.md', order: 0, kind: 'chapter' });

    // Le texte de l'auteur reste à sa place, et rien n'a touché au fichier extérieur.
    expect(readFileSync(join(book.outside, 'journal.md'), 'utf8')).toContain(SECRET);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});

test('un fichier réel rétabli à la place du lien rend son chapitre à la réouverture', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeLinkedBook();

  try {
    await openProject(app, window, join(book.alias, 'project.json'));
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });
    await expect(chapterButton(window, 'Annexe')).toBeDisabled();

    rmSync(join(book.real, 'chapters', '02-annexe.md'));
    writeFileSync(join(book.real, 'chapters', '02-annexe.md'), '# Annexe\n\nLe texte rapatrié.\n');

    await openProject(app, window, join(book.alias, 'project.json'));
    await expect(chapterButton(window, 'Annexe')).toBeEnabled({ timeout: 20_000 });
    await chapterButton(window, 'Annexe').click();
    await expect(editor(window)).toContainText('Le texte rapatrié');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});
