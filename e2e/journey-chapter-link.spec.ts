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
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  // Le contexte part en message `system` à chaque tour : le même lien, en plus court.
  symlinkSync(join(outside, 'journal.md'), join(real, 'context.md'));
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Par le Node d'Electron : better-sqlite3 est compilé pour lui, pas pour Playwright. */
function runInElectronNode(script: string, ...args: string[]): string {
  const electronPath = createRequire(import.meta.url)('electron') as string;
  return execFileSync(electronPath, ['-e', script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
}

/** L'index d'avant ce correctif : le texte du lien y est entré quand il était encore lu. */
function seedManuscriptIndex(projectDir: string): void {
  const moduleUrl = pathToFileURL(join(REPO_ROOT, 'dist/backend/core/vector-store/ManuscriptStore.js')).href;
  const script = `
    const [dbPath, modulePath, secret] = process.argv.slice(1);
    import(modulePath).then(({ ManuscriptStore }) => {
      const store = new ManuscriptStore({ dbPath });
      const rows = [['chapters/01-un.md', 'Texte du premier chapitre.'], ['chapters/02-annexe.md', secret]];
      rows.forEach(([relativePath, content], order) => {
        const id = 'chapitre-' + order;
        store.upsertChapter({ id, relativePath, title: relativePath, order, contentHash: 'x', indexedAt: new Date().toISOString() });
        store.addChunk({ id: id + '-0', chapterId: id, chunkIndex: 0, content, sectionTitle: null, line: 1 }, new Float32Array(8).fill(0.5));
      });
      store.close();
    });
  `;
  runInElectronNode(script, join(projectDir, '.cliodeck', 'brain.db'), moduleUrl, SECRET);
}

/** Les tables elles-mêmes, en lecture seule : l'app les tient ouvertes pendant ce temps. */
function manuscriptIndex(projectDir: string): { chapters: string[]; chunks: string[]; fts: string[] } {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    const column = (sql) => db.prepare(sql).pluck().all();
    process.stdout.write(JSON.stringify({
      chapters: column('SELECT relative_path FROM manuscript_chapters ORDER BY relative_path'),
      chunks: column('SELECT content FROM manuscript_chunks'),
      fts: column('SELECT content FROM manuscript_chunks_fts'),
    }));
    db.close();
  `;
  return JSON.parse(runInElectronNode(script, join(projectDir, '.cliodeck', 'brain.db')));
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
    await expect(annexe).toHaveAttribute('title', /remplacez ce lien par le fichier ou le dossier réel/);
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

    // Le contexte du projet en lien sortant : ni pour le modèle, ni pour l'interface.
    const hints = await window.evaluate(() =>
      (window as unknown as { electron: { fusion: { hints: { read: () => Promise<unknown> } } } }).electron.fusion.hints.read(),
    );
    expect(hints).toMatchObject({ success: true, hints: { present: false, raw: '' } });
    expect(JSON.stringify(hints)).not.toContain(SECRET);

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

test('un chapitre déjà indexé par le lien sort de l’index dès l’ouverture, sans sauvegarde', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeLinkedBook();
  seedManuscriptIndex(book.real);
  expect(manuscriptIndex(book.real).chunks).toContain(SECRET);

  try {
    await openProject(app, window, join(book.alias, 'project.json'));
    await expect(editor(window)).toContainText('Texte du premier chapitre', { timeout: 20_000 });

    // Le projet s'ouvre par un lien : le chapitre ordinaire ne part pas à tort.
    await expect.poll(() => manuscriptIndex(book.real)).toEqual({
      chapters: ['chapters/01-un.md'],
      chunks: ['Texte du premier chapitre.'],
      fts: ['Texte du premier chapitre.'],
    });
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});

/** Un livre reçu, sans `.cliodeck` : c'est l'état ordinaire d'un dépôt git. */
function makeReceivedBook(): { base: string; project: string; outside: string; projectJson: string } {
  const base = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-recu-'));
  const project = join(base, 'recu');
  const outside = join(base, 'dehors');
  mkdirSync(join(project, 'chapters'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, 'chapters', '01-un.md'), '# Un\n\nTexte ordinaire du livre reçu.\n');
  const projectJson = join(project, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000013',
      name: 'Livre reçu',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [{ id: 'c1', title: 'Un', filePath: 'chapters/01-un.md', order: 0, kind: 'chapter' }],
    }),
  );
  return { base, project, outside, projectJson };
}

const readHints = (window: Page): Promise<unknown> =>
  window.evaluate(() =>
    (window as unknown as { electron: { fusion: { hints: { read: () => Promise<unknown> } } } }).electron.fusion.hints.read(),
  );

test('la migration à l’ouverture n’apporte rien de ce qu’un .cliobrain lie hors du projet', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeReceivedBook();
  writeFileSync(join(book.outside, 'journal.md'), `${SECRET} : texte privé.\n`);
  const otherProject = join(book.outside, 'autre-projet');
  mkdirSync(otherProject);
  // La base d'un autre projet de l'auteur, avec le texte de son manuscrit.
  mkdirSync(join(otherProject, '.cliodeck'));
  seedManuscriptIndex(otherProject);
  mkdirSync(join(book.project, '.cliobrain'));
  symlinkSync(join(book.outside, 'journal.md'), join(book.project, '.cliobrain', 'hints.md'));
  symlinkSync(join(otherProject, '.cliodeck', 'brain.db'), join(book.project, '.cliobrain', 'brain.db'));

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Texte ordinaire du livre reçu', { timeout: 20_000 });

    expect(existsSync(join(book.project, '.cliodeck', 'hints.md'))).toBe(false);
    const hints = await readHints(window);
    expect(hints).toMatchObject({ success: true, hints: { present: false } });
    expect(JSON.stringify(hints)).not.toContain(SECRET);

    // Le projet a sa propre base, et rien de l'autre projet n'y est entré.
    const brainDb = join(book.project, '.cliodeck', 'brain.db');
    await expect.poll(() => existsSync(brainDb)).toBe(true);
    expect(readFileSync(brainDb).includes(SECRET)).toBe(false);
    expect(manuscriptIndex(otherProject).chunks).toContain(SECRET);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});

test('un .cliodeck/v2 lié hors du projet : le dossier de l’auteur reste intact', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeReceivedBook();
  writeFileSync(join(book.outside, 'config.json'), JSON.stringify({ schema_version: 2, name: SECRET }));
  writeFileSync(join(book.outside, 'hints.md'), `${SECRET} : texte privé.\n`);
  writeFileSync(join(book.outside, 'lettres.md'), 'Mes lettres.\n');
  mkdirSync(join(book.project, '.cliodeck'));
  symlinkSync(book.outside, join(book.project, '.cliodeck', 'v2'));

  try {
    await openProject(app, window, book.projectJson);
    await expect(editor(window)).toContainText('Texte ordinaire du livre reçu', { timeout: 20_000 });

    // Refusé comme un `.cliodeck` lié (D18) : la migration ne passe pas, et l'écran le dit.
    const toast = window.locator('.status-toast', { hasText: 'Dossier .cliodeck hors du projet' });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await toast.locator('.status-toast__details-btn').click();
    await expect(toast.locator('.status-toast__details')).toContainText(join('.cliodeck', 'v2'));

    expect(readdirSync(book.outside).sort()).toEqual(['config.json', 'hints.md', 'lettres.md']);
    expect(existsSync(join(book.project, '.cliodeck', 'lettres.md'))).toBe(false);
    expect(existsSync(join(book.project, '.cliodeck', 'hints.md'))).toBe(false);
    expect(existsSync(join(book.project, '.cliodeck', 'config.json'))).toBe(false);
    expect(JSON.stringify(await readHints(window))).not.toContain(SECRET);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});

test('quand c’est le dossier chapters qui sort du projet, le message le dit aussi', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const book = makeReceivedBook();
  const linked = join(book.outside, 'chapitres');
  mkdirSync(linked);
  writeFileSync(join(linked, '01-un.md'), `# Un\n\n${SECRET}\n`);
  rmSync(join(book.project, 'chapters'), { recursive: true });
  symlinkSync(linked, join(book.project, 'chapters'));

  try {
    await openProject(app, window, book.projectJson);
    const chapter = chapterButton(window, 'Un');
    await expect(chapter).toBeDisabled({ timeout: 20_000 });
    await expect(chapter).toHaveAttribute('title', /chapters\/01-un\.md ou son dossier/);
    await expect(chapter).toHaveAttribute('title', /le fichier ou le dossier réel/);
    await expect(editor(window)).not.toContainText(SECRET);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(book.base, { recursive: true, force: true });
  }
});
