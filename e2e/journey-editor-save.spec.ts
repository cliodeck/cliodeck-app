/**
 * Ce qui est tapé puis enregistré se retrouve sur le disque, et rien de
 * l'ancien texte ne survit à côté.
 *
 * C'est le parcours où des frappes ont déjà été perdues (rc.4 : quitter juste
 * après avoir tapé ; rc.5 : bascule entre chapitres). Les tests unitaires
 * couvrent les magasins ; ici l'application ouvre un vrai projet, l'éditeur
 * CodeMirror reçoit de vraies touches, et l'assertion porte sur **le fichier**.
 *
 * Le projet est posé sur le disque plutôt que créé par la modale : ouvrir est
 * le chemin qu'emprunte aussi un projet reçu d'un collègue, et cela évite
 * l'accompagnement au démarrage, qui n'est pas l'objet du test.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

/** Le pont du preload, tel que les tests l'appellent depuis la page. */
interface ElectronWindow {
  electron: {
    fs: {
      readUserFile(filePath: string): Promise<{ kind: string; content?: string; reason?: string }>;
      writeFile(filePath: string, content: string, options?: { exclusive?: boolean }): Promise<unknown>;
      quarantineFile(
        filePath: string
      ): Promise<{ success: true; backupPath: string } | { success: false; error: string }>;
    };
  };
}

const ORIGINAL = '# Chapitre premier\n\nTexte déjà écrit.\n';
const TYPED = 'Une phrase tapée dans l’éditeur.';

function makeProject(): { dir: string; projectJson: string; documentMd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-projet-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000000',
      name: 'Projet E2E',
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const documentMd = join(dir, 'document.md');
  writeFileSync(documentMd, ORIGINAL);
  return { dir, projectJson, documentMd };
}

async function openProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editorOf = (window: Page) => window.locator('.codemirror-editor .cm-content');

async function typeAtEnd(window: Page, text: string): Promise<void> {
  await editorOf(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(text);
}

/** « # Été » en Latin-1 : des octets qui ne forment pas de l'UTF-8. */
const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test('le texte tapé puis enregistré atteint document.md', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    // Le sélecteur de fichier natif bloquerait le test : on répond à sa place.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, projet.projectJson);

    await window.locator('button[title="Ouvrir un projet"]').first().click();

    const editor = window.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Texte déjà écrit', { timeout: 20_000 });

    await editor.click();
    await window.keyboard.press('ControlOrMeta+End');
    await window.keyboard.type(`\n${TYPED}\n`);

    await window.locator('.toolbar-btn[title="Enregistrer"]').first().click();

    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toContain(TYPED);

    // Le texte d'origine est conservé : on ajoute, on n'écrase pas.
    expect(readFileSync(projet.documentMd, 'utf8')).toContain('Texte déjà écrit');
    // La sauvegarde passe par un fichier temporaire : rien ne doit en rester.
    expect(readdirSync(projet.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('le socle de fichiers est joignable depuis le renderer, et décide sur le vrai disque', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  const dehors = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dehors-'));

  // Les liaisons du preload n'existent que dans l'app : Vitest ne les voit pas.
  const fsBridge = {
    readUserFile: (filePath: string) =>
      window.evaluate((p) => (window as unknown as ElectronWindow).electron.fs.readUserFile(p), filePath),
    writeExclusive: (filePath: string, content: string) =>
      window.evaluate(
        ([p, c]) =>
          (window as unknown as ElectronWindow).electron.fs.writeFile(p, c, { exclusive: true }).then(
            () => 'écrit',
            (error: Error) => error.message
          ),
        [filePath, content] as const
      ),
    quarantineFile: (filePath: string) =>
      window.evaluate((p) => (window as unknown as ElectronWindow).electron.fs.quarantineFile(p), filePath),
  };

  try {
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, projet.projectJson);
    await window.locator('button[title="Ouvrir un projet"]').first().click();
    await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte déjà écrit', {
      timeout: 20_000,
    });

    expect(await fsBridge.readUserFile(projet.documentMd)).toEqual({ kind: 'ok', content: ORIGINAL });
    expect(await fsBridge.readUserFile(join(projet.dir, 'absent.md'))).toEqual({ kind: 'absent' });

    // Le TextDecoder strict du Node d'Electron, pas seulement celui de Vitest.
    const latin1 = join(projet.dir, 'latin1.md');
    writeFileSync(latin1, Buffer.from([0x45, 0x74, 0xe9]));
    expect(await fsBridge.readUserFile(latin1)).toMatchObject({ kind: 'unreadable', reason: 'encoding' });

    const secret = join(dehors, 'secret.md');
    writeFileSync(secret, 'à ne pas lire');
    expect(await fsBridge.readUserFile(secret)).toMatchObject({ kind: 'unreadable', reason: 'refused' });

    // L'écriture exclusive crée le fichier absent et n'écrase pas celui qui existe.
    const seed = join(projet.dir, 'neuf.md');
    expect(await fsBridge.writeExclusive(seed, '# Neuf\n')).toBe('écrit');
    expect(readFileSync(seed, 'utf8')).toBe('# Neuf\n');
    expect(await fsBridge.writeExclusive(projet.documentMd, '# Écrasé\n')).toContain('EEXIST');
    expect(readFileSync(projet.documentMd, 'utf8')).toBe(ORIGINAL);

    // La mise de côté garde les octets, à côté du fichier.
    const abime = join(projet.dir, 'ideas.json');
    writeFileSync(abime, '{ tronqué');
    const quarantined = await fsBridge.quarantineFile(abime);
    if (!quarantined.success) throw new Error(quarantined.error);
    expect(quarantined.backupPath).toContain('ideas.json.illisible-');
    expect(readFileSync(quarantined.backupPath, 'utf8')).toBe('{ tronqué');
    expect(existsSync(abime)).toBe(false);

    expect((await fsBridge.quarantineFile(secret)).success).toBe(false);
    expect(readFileSync(secret, 'utf8')).toBe('à ne pas lire');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
    rmSync(dehors, { recursive: true, force: true });
  }
});

test('projet au document en Latin-1 : pas un octet ne change, et l’auteur sait quoi faire', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  writeFileSync(projet.documentMd, LATIN1);

  try {
    await openProject(app, window, projet.projectJson);

    const toast = window.locator('.status-toast--error');
    await expect(toast).toContainText('document de ce projet', { timeout: 20_000 });
    await expect(toast).toContainText('UTF-8');
    expect(await editorOf(window).textContent()).not.toContain('\uFFFD');

    // Le tampon est sans titre : rien de ce qu'on y tape n'atteint le fichier refusé.
    await typeAtEnd(window, 'Une idée.');
    await window.waitForTimeout(3_500);
    expect(readFileSync(projet.documentMd).equals(LATIN1)).toBe(true);
    expect(readdirSync(projet.dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('fichier avec BOM : il s’ouvre sans que le BOM se voie, et ses octets reviennent tels quels', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  const withBom = Buffer.concat([BOM, Buffer.from(ORIGINAL, 'utf8')]);
  writeFileSync(projet.documentMd, withBom);

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });
    await expect(window.locator('.status-toast--error')).toHaveCount(0);
    // Ni caractère de contrôle à l'écran, ni titre de première ligne resté en texte brut.
    await expect(editorOf(window).locator('.cm-specialChar')).toHaveCount(0);

    await window.locator('.toolbar-btn[title="Enregistrer"]').first().click();
    await window.waitForTimeout(500);
    expect(readFileSync(projet.documentMd).equals(withBom)).toBe(true);

    await typeAtEnd(window, 'Suite.');
    await expect
      .poll(() => readFileSync(projet.documentMd).equals(Buffer.concat([withBom, Buffer.from('Suite.', 'utf8')])), {
        timeout: 15_000,
      })
      .toBe(true);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('document absent : le gabarit se crée, s’ouvre, et reçoit la frappe', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  rmSync(projet.documentMd);

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Projet E2E', { timeout: 20_000 });
    expect(readFileSync(projet.documentMd, 'utf8')).toBe('# Projet E2E\n');
    await expect(window.locator('.status-toast--error')).toHaveCount(0);

    await typeAtEnd(window, 'Première phrase.');
    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toBe('# Projet E2E\nPremière phrase.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});
