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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Compte les écritures du document : combien d'essais l'autosave a faits. */
async function countSaves(app: ElectronApplication): Promise<() => Promise<number>> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = handlers.get('editor:save-file');
    if (!original) throw new Error('editor:save-file introuvable');
    const counter = globalThis as unknown as { __saves: number };
    counter.__saves = 0;
    handlers.set('editor:save-file', async (...args: unknown[]) => {
      counter.__saves += 1;
      return original(...args);
    });
  });
  return () => app.evaluate(() => (globalThis as unknown as { __saves: number }).__saves);
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

test('frappe pendant une écriture lente : elle part sur le disque sans autre geste', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });

    // Un disque lent (clé USB, dossier réseau) : 900 ms par écriture.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      })._invokeHandlers;
      const original = handlers.get('editor:save-file');
      if (!original) throw new Error('editor:save-file introuvable');
      handlers.set('editor:save-file', async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return original(...args);
      });
    });

    await typeAtEnd(window, 'Phrase un.');
    // Par le menu : un clic sur le bouton retirerait le focus à l'éditeur.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:save-file');
    });
    await window.waitForTimeout(100);
    await window.keyboard.type(' Phrase deux.');

    // Ni frappe, ni clic : l'autosave reprend, car il reste du texte à écrire.
    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toBe(`${ORIGINAL}Phrase un. Phrase deux.`);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('écriture impossible : un seul message, et le texte part tout seul une fois l’accès revenu', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });
    const saves = await countSaves(app);
    const toast = window.locator('.status-toast--error');

    chmodSync(projet.documentMd, 0o444);
    await typeAtEnd(window, 'Une phrase.');

    await expect(toast).toContainText('Enregistrement automatique impossible', { timeout: 10_000 });
    await expect.poll(saves, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await expect(toast).toHaveCount(1);
    expect(readFileSync(projet.documentMd, 'utf8')).toBe(ORIGINAL);

    chmodSync(projet.documentMd, 0o644);

    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 20_000 })
      .toBe(`${ORIGINAL}Une phrase.`);
    await expect(toast).toHaveCount(0);
  } finally {
    chmodSync(projet.documentMd, 0o644);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
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
    await expect(toast).toContainText('document sans titre');
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

test('projet au document en Latin-1 : une fois converti et rouvert, le document s’affiche et le message s’en va', async () => {
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

    writeFileSync(projet.documentMd, '# Été\n');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, projet.documentMd);
    await window.locator('.toolbar-btn[title="Ouvrir"]').first().click();

    await expect(editorOf(window)).toContainText('Été', { timeout: 10_000 });
    await expect(toast).toHaveCount(0);

    await typeAtEnd(window, 'Suite.');
    await expect.poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 }).toBe('# Été\nSuite.');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('livre au chapitre en Latin-1 : Renuméroter refuse sans toucher à un octet, et repart une fois le fichier converti', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-livre-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'));
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Livre E2E',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [
        { id: 'c1', title: 'Premier', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Second', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
      ],
    }),
  );
  const first = join(dir, 'chapters', '01.md');
  const second = join(dir, 'chapters', '02.md');
  const FIRST = '# Premier\n\nTexte[^5].\n\n[^5]: Note un.\n';
  const SECOND = '# Second\n\nTexte accentué : été[^9].\n\n[^9]: Note deux, évêque.\n';
  writeFileSync(first, FIRST);
  writeFileSync(second, Buffer.from(SECOND, 'latin1'));
  const renumber = window.locator('button[title="Renuméroter les notes"]').first();
  const alert = window.locator('#alert-dialog-message');

  try {
    await openProject(app, window, projectJson);
    await expect(editorOf(window)).toContainText('Premier', { timeout: 20_000 });

    await renumber.click();
    await expect(alert).toContainText('le manuscrit est inchangé', { timeout: 10_000 });
    await expect(alert).toContainText('Second');
    await expect(alert).toContainText('UTF-8');
    await window.locator('.alert-dialog-btn-ok').click();

    await window.waitForTimeout(500);
    expect(readFileSync(second).equals(Buffer.from(SECOND, 'latin1'))).toBe(true);
    expect(readFileSync(first, 'utf8')).toBe(FIRST);
    await expect(editorOf(window)).toContainText('[^5]');

    // Le remède que le message prescrit.
    writeFileSync(second, SECOND);
    await renumber.click();
    await expect(alert).toContainText('2 chapitre', { timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    expect(readFileSync(second, 'utf8')).toBe(SECOND.replaceAll('[^9]', '[^2]'));
    await expect.poll(() => readFileSync(first, 'utf8'), { timeout: 15_000 }).toBe(FIRST.replaceAll('[^5]', '[^1]'));
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('livre dont un chapitre disparaît pendant la session : le refus, puis le clic suivant renumérote le reste', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-livre-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'));
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Livre E2E',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [
        { id: 'c1', title: 'Premier', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Second', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
        { id: 'c3', title: 'Troisième', filePath: 'chapters/03.md', order: 2, kind: 'chapter' },
      ],
    }),
  );
  const first = join(dir, 'chapters', '01.md');
  const second = join(dir, 'chapters', '02.md');
  const third = join(dir, 'chapters', '03.md');
  const FIRST = '# Premier\n\nTexte[^5].\n\n[^5]: Note un.\n';
  const THIRD = '# Troisième\n\nTexte[^9].\n\n[^9]: Note trois.\n';
  writeFileSync(first, FIRST);
  writeFileSync(second, '# Second\n\nTexte[^7].\n\n[^7]: Note deux.\n');
  writeFileSync(third, THIRD);
  const renumber = window.locator('button[title="Renuméroter les notes"]').first();
  const alert = window.locator('#alert-dialog-message');

  try {
    await openProject(app, window, projectJson);
    await expect(editorOf(window)).toContainText('Premier', { timeout: 20_000 });

    rmSync(second);
    await renumber.click();
    await expect(alert).toContainText('le manuscrit est inchangé', { timeout: 10_000 });
    await expect(alert).toContainText('Second');
    await expect(alert).toContainText('relancez la renumérotation');
    await window.locator('.alert-dialog-btn-ok').click();
    expect(readFileSync(third, 'utf8')).toBe(THIRD);

    // Sans quitter le projet : le navigateur sait que le chapitre manque, comme à l'ouverture.
    await renumber.click();
    await expect(alert).toContainText('2 chapitre', { timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    expect(readFileSync(third, 'utf8')).toBe(THIRD.replaceAll('[^9]', '[^2]'));
    await expect.poll(() => readFileSync(first, 'utf8'), { timeout: 15_000 }).toBe(FIRST.replaceAll('[^5]', '[^1]'));
    expect(existsSync(second)).toBe(false);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('note de lecture en Latin-1 : l’étiqueter refuse sans toucher à un octet, et repart une fois le fichier converti', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  writeFileSync(
    join(projet.dir, 'references.bib'),
    '@book{dupont2020,\n  author = {Dupont, Jean},\n  title = {Un titre},\n  year = {2020},\n}\n',
  );
  writeFileSync(
    projet.projectJson,
    JSON.stringify({
      ...JSON.parse(readFileSync(projet.projectJson, 'utf8')),
      bibliographySource: { type: 'file', filePath: 'references.bib' },
    }),
  );
  mkdirSync(join(projet.dir, 'reading-notes'));
  const note = join(projet.dir, 'reading-notes', 'dupont2020.md');
  const NOTE = "---\ncitekey: dupont2020\n---\n\n# Dupont\n\nL'évêque a été reçu.\n";
  const latin1 = Buffer.from(NOTE, 'latin1');
  writeFileSync(note, latin1);
  const alert = window.locator('#alert-dialog-message');

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });

    await window.locator('#left-tab-bibliography').click();
    await window.locator('.citation-header').filter({ hasText: 'Dupont' }).click();
    const input = window.locator('.tag-manager .tag-input').first();
    await input.fill('lu');
    await input.press('Enter');

    await expect(alert).toContainText('UTF-8', { timeout: 10_000 });
    await expect(alert).toContainText('étiquettes');
    await window.locator('.alert-dialog-btn-ok').click();
    await expect(window.locator('.tag-manager .tag')).toHaveCount(0);
    expect(readFileSync(note).equals(latin1)).toBe(true);
    expect(readdirSync(join(projet.dir, 'reading-notes'))).toEqual(['dupont2020.md']);

    // Le remède que le message prescrit.
    writeFileSync(note, NOTE);
    await input.fill('lu');
    await input.press('Enter');
    await expect(window.locator('.tag-manager .tag')).toHaveCount(1, { timeout: 10_000 });
    const converted = readFileSync(note, 'utf8');
    expect(converted).toContain('- lu');
    expect(converted).toContain("L'évêque a été reçu.");
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('ouvrir un fichier en Latin-1 : refus expliqué, et le document ouvert reste', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  const latin1 = join(projet.dir, 'ancien.md');
  writeFileSync(latin1, LATIN1);

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, latin1);
    await window.locator('.toolbar-btn[title="Ouvrir"]').first().click();

    await expect(window.locator('#alert-dialog-message')).toContainText('UTF-8', { timeout: 10_000 });
    await window.locator('.alert-dialog-btn-ok').click();

    await expect(editorOf(window)).toContainText('Texte déjà écrit');
    expect(readFileSync(latin1).equals(LATIN1)).toBe(true);

    // L'éditeur est toujours sur son document : la frappe y va.
    await typeAtEnd(window, 'Suite.');
    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toBe(`${ORIGINAL}Suite.`);
    expect(readFileSync(latin1).equals(LATIN1)).toBe(true);
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

// Les accélérateurs natifs ne passent pas par Playwright : le menu est simulé par
// `webContents.send`, ce que fait le main à la réception du raccourci.
const sendMenu = (app: ElectronApplication, channel: string) =>
  app.evaluate(({ BrowserWindow }, c) => {
    BrowserWindow.getAllWindows()[0].webContents.send(c);
  }, channel);

/** Les rejets non gérés de la page : c'est là que finissait un enregistrement raté, sans un mot. */
async function watchRejections(window: Page): Promise<() => Promise<string[]>> {
  await window.evaluate(() => {
    const page = window as unknown as { __rejections: string[] };
    page.__rejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      page.__rejections.push(String(event.reason));
    });
  });
  return () => window.evaluate(() => (window as unknown as { __rejections: string[] }).__rejections);
}

const SAVE_ERROR = 'Erreur lors de la sauvegarde du fichier';
const alertMessage = (window: Page) => window.locator('.alert-dialog-message');

/** Ferme les alertes à l'écran : les écouteurs de menu n'étant jamais retirés, une commande en ouvre deux. */
async function closeAlerts(window: Page): Promise<void> {
  const ok = window.locator('.alert-dialog-btn-ok');
  await expect
    .poll(async () => {
      if (await ok.count()) await ok.click();
      return ok.count();
    })
    .toBe(0);
}

async function stubSaveDialog(app: ElectronApplication, target: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
}

async function stubOpenDialog(app: ElectronApplication, target: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, target);
}

/** Un tampon sans titre, hors du projet, avec du texte qui n'existe nulle part ailleurs. */
async function untitledBuffer(app: ElectronApplication, window: Page, text: string): Promise<void> {
  await sendMenu(app, 'menu:new-file');
  await window.locator('.confirm-dialog .confirm-dialog-btn-confirm').click();
  await expect(editorOf(window)).not.toContainText('Texte déjà écrit');
  await typeAtEnd(window, text);
}

test('Cmd+S sur un fichier non inscriptible : l’auteur le sait, le texte reste, et le second essai l’écrit', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });
    const rejections = await watchRejections(window);

    chmodSync(projet.documentMd, 0o444);
    await typeAtEnd(window, 'Une phrase.');
    await sendMenu(app, 'menu:save-file');

    await expect(alertMessage(window).first()).toHaveText(SAVE_ERROR, { timeout: 10_000 });
    await closeAlerts(window);
    expect(await rejections()).toEqual([]);
    expect(readFileSync(projet.documentMd, 'utf8')).toBe(ORIGINAL);
    await expect(editorOf(window)).toContainText('Une phrase.');

    chmodSync(projet.documentMd, 0o644);
    await sendMenu(app, 'menu:save-file');

    await expect
      .poll(() => readFileSync(projet.documentMd, 'utf8'), { timeout: 15_000 })
      .toBe(`${ORIGINAL}Une phrase.`);
    // Le message de l'autosave, s'il a eu le temps de partir, n'a plus d'objet.
    await expect(window.locator('.status-toast--error')).toHaveCount(0);
  } finally {
    chmodSync(projet.documentMd, 0o644);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

test('Cmd+O vers un fichier sain, alors que le document ouvert refuse l’écriture : le message parle de l’enregistrement, le texte reste, et le second essai ouvre', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const projet = makeProject();
  const sain = join(projet.dir, 'sain.md');
  writeFileSync(sain, 'Un fichier parfaitement lisible.');

  try {
    await openProject(app, window, projet.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });
    await stubOpenDialog(app, sain);

    chmodSync(projet.documentMd, 0o444);
    await typeAtEnd(window, 'Une phrase.');
    await sendMenu(app, 'menu:open-file');

    await expect(alertMessage(window).first()).toHaveText(SAVE_ERROR, { timeout: 10_000 });
    await closeAlerts(window);
    expect(readFileSync(projet.documentMd, 'utf8')).toBe(ORIGINAL);
    await expect(editorOf(window)).toContainText('Une phrase.');

    chmodSync(projet.documentMd, 0o644);
    await sendMenu(app, 'menu:open-file');

    await expect(editorOf(window)).toContainText('Un fichier parfaitement lisible.', { timeout: 15_000 });
    expect(readFileSync(projet.documentMd, 'utf8')).toBe(`${ORIGINAL}Une phrase.`);
  } finally {
    chmodSync(projet.documentMd, 0o644);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(projet.dir, { recursive: true, force: true });
  }
});

for (const door of ['bouton', 'récents'] as const) {
  test(`changer de projet (${door}) alors que le document ouvert refuse l’écriture : le message parle de l’enregistrement, le texte reste, et le second essai ouvre`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const sortant = makeProject();
    const demande = makeProject();
    writeFileSync(demande.documentMd, '# Autre projet\n\nLe texte du projet demandé.\n');

    const askForProject = async (): Promise<void> => {
      if (door === 'bouton') {
        await openProject(app, window, demande.projectJson);
        return;
      }
      if (!(await window.locator('.recent-project-content').count())) {
        await window.getByText('Projets récents').click();
      }
      await window.locator('.recent-project-content', { hasText: demande.dir }).click();
    };

    try {
      // Le projet demandé entre dans les récents par une première ouverture, sans refus.
      await openProject(app, window, demande.projectJson);
      await expect(editorOf(window)).toContainText('Le texte du projet demandé.', { timeout: 20_000 });
      await openProject(app, window, sortant.projectJson);
      await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });

      chmodSync(sortant.documentMd, 0o444);
      await typeAtEnd(window, 'Une phrase.');
      await askForProject();

      await expect(alertMessage(window)).toHaveText(SAVE_ERROR, { timeout: 10_000 });
      await closeAlerts(window);
      expect(readFileSync(sortant.documentMd, 'utf8')).toBe(ORIGINAL);
      await expect(editorOf(window)).toContainText('Une phrase.');

      chmodSync(sortant.documentMd, 0o644);
      await askForProject();

      await expect(editorOf(window)).toContainText('Le texte du projet demandé.', { timeout: 20_000 });
      expect(readFileSync(sortant.documentMd, 'utf8')).toBe(`${ORIGINAL}Une phrase.`);
    } finally {
      chmodSync(sortant.documentMd, 0o644);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(sortant.dir, { recursive: true, force: true });
      rmSync(demande.dir, { recursive: true, force: true });
    }
  });
}

test('créer un projet alors que le document ouvert refuse l’écriture : le message parle de l’enregistrement, la modale garde la saisie, et le second essai crée', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const sortant = makeProject();
  const parent = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-parent-'));
  const nameField = window.getByPlaceholder('Mon article');
  const createButton = window.locator('.form-actions button', { hasText: 'Créer' });

  try {
    await openProject(app, window, sortant.projectJson);
    await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });

    chmodSync(sortant.documentMd, 0o444);
    await typeAtEnd(window, 'Une phrase.');

    await window.locator('button[title="Nouveau projet"]').first().click();
    await nameField.fill('Neuf');
    await stubOpenDialog(app, parent);
    await window.locator('.path-selector button').click();
    await expect(window.locator('.path-selector input')).toHaveValue(parent);
    await createButton.click();

    await expect(alertMessage(window)).toHaveText(SAVE_ERROR, { timeout: 10_000 });
    await closeAlerts(window);
    await expect(nameField).toHaveValue('Neuf');
    expect(existsSync(join(parent, 'Neuf'))).toBe(false);
    expect(readFileSync(sortant.documentMd, 'utf8')).toBe(ORIGINAL);

    chmodSync(sortant.documentMd, 0o644);
    await createButton.click();

    await expect.poll(() => existsSync(join(parent, 'Neuf', 'project.json')), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(sortant.documentMd, 'utf8')).toBe(`${ORIGINAL}Une phrase.`);
  } finally {
    chmodSync(sortant.documentMd, 0o644);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(sortant.dir, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});

test('livre : changer de chapitre alors que le chapitre ouvert refuse l’écriture : le message parle de l’enregistrement, sans le texte du système, et le second essai bascule', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-livre-'));
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  mkdirSync(join(dir, 'chapters'));
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Livre E2E',
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: [
        { id: 'c1', title: 'Premier', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Second', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
      ],
    }),
  );
  const first = join(dir, 'chapters', '01.md');
  const FIRST = '# Premier\n\nLe texte du premier chapitre.\n';
  writeFileSync(first, FIRST);
  writeFileSync(join(dir, 'chapters', '02.md'), '# Second\n\nLe texte du second chapitre.\n');
  const secondChapter = window.locator('button.chapter-item-open', { hasText: 'Second' });

  try {
    await openProject(app, window, projectJson);
    await expect(editorOf(window)).toContainText('Le texte du premier chapitre.', { timeout: 20_000 });

    chmodSync(first, 0o444);
    await typeAtEnd(window, 'Une phrase.');
    await secondChapter.click();

    await expect(alertMessage(window)).toHaveText(SAVE_ERROR, { timeout: 10_000 });
    await closeAlerts(window);
    expect(readFileSync(first, 'utf8')).toBe(FIRST);
    await expect(editorOf(window)).toContainText('Une phrase.');

    chmodSync(first, 0o644);
    await secondChapter.click();

    await expect(editorOf(window)).toContainText('Le texte du second chapitre.', { timeout: 15_000 });
    expect(readFileSync(first, 'utf8')).toBe(`${FIRST}Une phrase.`);
  } finally {
    chmodSync(first, 0o644);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const door of ['bouton', 'menu'] as const) {
  test(`Enregistrer sous (${door}) vers un dossier refusé : l’auteur le sait, le tampon garde son texte, et le second essai l’écrit`, async () => {
    const outcome = await launchApp();
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const projet = makeProject();
    const dehors = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dehors-'));
    const note = join(dehors, 'note.md');
    const save = () =>
      door === 'bouton'
        ? window.locator('.toolbar-btn[title="Enregistrer"]').first().click()
        : sendMenu(app, 'menu:save-file');

    try {
      await openProject(app, window, projet.projectJson);
      await expect(editorOf(window)).toContainText('Texte déjà écrit', { timeout: 20_000 });
      const rejections = await watchRejections(window);
      await untitledBuffer(app, window, 'Une idée à part.');
      await stubSaveDialog(app, note);

      chmodSync(dehors, 0o555);
      await save();

      await expect(alertMessage(window).first()).toHaveText(SAVE_ERROR, { timeout: 10_000 });
      await closeAlerts(window);
      expect(await rejections()).toEqual([]);
      expect(existsSync(note)).toBe(false);
      await expect(editorOf(window)).toContainText('Une idée à part.');

      chmodSync(dehors, 0o755);
      await save();

      await expect.poll(() => existsSync(note), { timeout: 15_000 }).toBe(true);
      expect(readFileSync(note, 'utf8')).toBe('Une idée à part.');
      expect(readFileSync(projet.documentMd, 'utf8')).toBe(ORIGINAL);
    } finally {
      chmodSync(dehors, 0o755);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(projet.dir, { recursive: true, force: true });
      rmSync(dehors, { recursive: true, force: true });
    }
  });
}

// L'écouteur jamais retiré garde le `t` du premier rendu, en français : il répond le premier.
for (const [language, saveLabel, message, openMessage] of [
  ['en', 'Save', 'Error saving file', 'This file could not be opened. It may be missing or unreadable.'],
  [
    'de',
    'Speichern',
    'Fehler beim Speichern der Datei',
    'Diese Datei konnte nicht geöffnet werden. Sie ist möglicherweise nicht vorhanden oder unlesbar.',
  ],
] as const) {
  test(`Cmd+S en échec, interface en ${language} : le message est dans la langue de l’auteur`, async () => {
    const outcome = await launchApp({ language });
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const dehors = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dehors-'));

    try {
      await expect(window.locator(`.toolbar-btn[title="${saveLabel}"]`).first()).toBeVisible({ timeout: 20_000 });
      await stubSaveDialog(app, join(dehors, 'note.md'));
      chmodSync(dehors, 0o555);

      await sendMenu(app, 'menu:save-file');

      await expect(alertMessage(window).first()).toHaveText(message, { timeout: 10_000 });
    } finally {
      chmodSync(dehors, 0o755);
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(dehors, { recursive: true, force: true });
    }
  });

  test(`Cmd+O sur un fichier illisible, interface en ${language} : le message est dans la langue de l’auteur`, async () => {
    const outcome = await launchApp({ language });
    if (outcome.kind === 'skip') {
      test.skip(true, outcome.reason);
      return;
    }
    const { app, window, userDataDir } = outcome.value;
    const dehors = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-dehors-'));
    const illisible = join(dehors, 'illisible.md');
    writeFileSync(illisible, 'Du texte.');

    try {
      await expect(window.locator(`.toolbar-btn[title="${saveLabel}"]`).first()).toBeVisible({ timeout: 20_000 });
      await stubOpenDialog(app, illisible);
      chmodSync(illisible, 0o000);

      await sendMenu(app, 'menu:open-file');

      await expect(alertMessage(window).first()).toHaveText(openMessage, { timeout: 10_000 });
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(dehors, { recursive: true, force: true });
    }
  });
}
