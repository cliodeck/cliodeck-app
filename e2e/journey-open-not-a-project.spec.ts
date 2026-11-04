/**
 * « Ouvrir un projet » sur un fichier qui n'en est pas un, dans la vraie app : le preload, les vrais
 * handlers, le vrai disque, dossiers temporaires uniquement.
 *
 * Le dialogue filtre sur l'extension : un `package.json` recevait `lastOpenedAt`, son dossier un
 * `.cliodeck` et un `brain.db`, et il entrait dans les récents (S11-1-18). Le refus doit tomber avant
 * que le projet ouvert soit quitté : ni détaché, ni rouvert, et la frappe reste (A35). Jugé sur tout
 * le dossier : les noms, les tailles, les dates, les octets.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './_helpers/launch';

const CSL_JSON = `${JSON.stringify(
  [
    { id: 'braudel1949', type: 'book', title: 'La Méditerranée' },
    { id: 'bloch1924', type: 'book', title: 'Les rois thaumaturges' },
  ],
  null,
  2,
)}\n`;
const PACKAGE_JSON = `${JSON.stringify({ name: 'mon-outil', version: '1.0.0' }, null, 2)}\n`;
const TYPED = ' Une phrase tapée, pas encore enregistrée.';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-manifeste-'));
  roots.push(root);
  return root;
}

interface ProjectOnDisk {
  dir: string;
  projectJson: string;
  documentMd: string;
}

function makeProject(root: string, name: string, manifest: Record<string, unknown>): ProjectOnDisk {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(projectJson, JSON.stringify(manifest));
  const documentMd = join(dir, 'document.md');
  writeFileSync(documentMd, `# ${name}\n`);
  return { dir, projectJson, documentMd };
}

/** Tout un dossier : chaque entrée, sa taille, sa date, ses octets, et la date du dossier lui-même. */
function folderState(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = { [`${prefix}.`]: String(lstatSync(dir).mtimeMs) };
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) Object.assign(out, folderState(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = `${stat.size}|${stat.mtimeMs}|${readFileSync(full).toString('base64')}`;
  }
  return out;
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function pick(app: ElectronApplication, window: Page, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, filePath);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

const editor = (window: Page) => window.locator('.codemirror-editor .cm-content');
const recents = (window: Page) =>
  window.evaluate(() => window.electron.project.getRecent()) as Promise<string[]>;

async function openProject(app: ElectronApplication, window: Page, project: ProjectOnDisk, title: string): Promise<void> {
  await pick(app, window, project.projectJson);
  await expect(editor(window)).toContainText(title, { timeout: 20_000 });
}

async function withApp(
  run: (app: ElectronApplication, window: Page) => Promise<void>,
  options: { userDataDir?: string } = {},
): Promise<void> {
  const outcome = await launchApp(options);
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  try {
    await run(app, window);
  } finally {
    await app.close().catch(() => undefined);
    if (!options.userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** La fin des animations. Le curseur de l'éditeur clignote sans fin, et une animation peut être annulée. */
const settled = (window: Page) =>
  window.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );

/** Le refus affiché : le fichier nommé, ce qui n'a pas bougé, quoi choisir, et aucun code. */
async function expectRefusalNaming(window: Page, fileName: string): Promise<void> {
  const message = window.locator('.alert-dialog-message');
  await expect(message).toBeVisible({ timeout: 10_000 });
  await expect(message).toContainText(`« ${fileName} » n'est pas un fichier de projet ClioDeck`);
  await expect(message).toContainText("Il n'a pas été modifié");
  await expect(message).toContainText('ce qui était ouvert reste ouvert');
  // Même sur un `project.json` d'un autre outil : celui à choisir n'est pas celui-là.
  await expect(message).toContainText('le fichier project.json que ClioDeck a créé');
  await expect(message).not.toContainText(/not_a_project|manifest_invalid|Failed|Error/);
  // L'indicateur de chargement ne reste pas en route.
  await expect(window.locator('.project-loading-overlay')).toHaveCount(0);
}

test.describe('ouvrir ce qui n’est pas un projet', () => {
  test.setTimeout(120_000);

  test('A ouvert avec du texte tapé : un CSL-JSON, un package.json et un .json vide ne le quittent pas, et rien ne les touche', async () => {
    const root = tempRoot();
    const a = makeProject(root, 'A', { id: 'a', name: 'A', type: 'article', createdAt: new Date().toISOString() });
    const beside = join(a.dir, 'references.json');
    writeFileSync(beside, CSL_JSON);
    const besideBefore = readFileSync(beside);
    const other = join(root, 'Dossier d’un autre outil');
    mkdirSync(other);
    const files: Array<[string, string]> = [
      ['references.json', CSL_JSON],
      ['package.json', PACKAGE_JSON],
      ['vide.json', ''],
    ];
    for (const [name, content] of files) writeFileSync(join(other, name), content);
    const before = folderState(other);

    await withApp(async (app, window) => {
      await openProject(app, window, a, 'A');
      await editor(window).click();
      await window.keyboard.press('ControlOrMeta+End');
      await window.keyboard.type(TYPED);
      await expect(editor(window)).toContainText(TYPED);
      // Une marque sur la vue : un nouveau montage la perdrait.
      await window.locator('.cm-editor').evaluate((view) => {
        (view as HTMLElement).dataset.memeVue = 'oui';
      });
      const recentsBefore = await recents(window);
      expect(recentsBefore).toEqual([a.projectJson]);

      for (const [name] of files) {
        await pick(app, window, join(other, name));
        await expectRefusalNaming(window, name);
        // La boîte entre en fondu : avant la fin de l'animation, la capture ne la montre pas.
        await settled(window);
        await window.screenshot({ path: join(process.env.E2E_SHOTS ?? tmpdir(), `pas-un-projet-${name}.png`) });
        await window.locator('.alert-dialog-btn-ok').click();
        await expect(window.locator('.alert-dialog-message')).toHaveCount(0);

        // A reste à l'écran, le même éditeur, avec la frappe.
        await expect(window.locator('.cm-editor[data-meme-vue="oui"]')).toHaveCount(1);
        await expect(editor(window)).toContainText(TYPED);
        await expect(window.locator('.project-meta')).toContainText(a.dir);
        expect(folderState(other)).toEqual(before);
        expect(await recents(window)).toEqual(recentsBefore);

        // `project:load` direct : la même garde, côté main.
        const direct = await window.evaluate((file) => window.electron.project.load(file), join(other, name));
        expect(direct).toMatchObject({ success: false, code: 'not_a_project', fileName: name });
        expect(folderState(other)).toEqual(before);
      }

      // Le défaut tel qu'il a été trouvé : le CSL-JSON posé à côté du projet ouvert.
      await pick(app, window, beside);
      await expectRefusalNaming(window, 'references.json');
      await window.locator('.alert-dialog-btn-ok').click();
      expect(readFileSync(beside).equals(besideBefore)).toBe(true);

      // Le main n'a pas basculé : A s'enregistre encore, avec ce qui a été tapé.
      await editor(window).click();
      await window.keyboard.press('ControlOrMeta+S');
      await expect.poll(() => readFileSync(a.documentMd, 'utf8'), { timeout: 10_000 }).toContain(TYPED);
      expect(await recents(window)).toEqual(recentsBefore);
    });

    expect(folderState(other)).toEqual(before);
    for (const trace of ['.cliodeck', 'brain.db', 'context.md', 'document.md', 'project.json']) {
      expect(existsSync(join(other, trace))).toBe(false);
    }
    expect(readFileSync(beside).equals(besideBefore)).toBe(true);
  });

  test('sans projet ouvert : le refus laisse l’écran d’accueil, sans trace', async () => {
    const other = join(tempRoot(), 'Autre');
    mkdirSync(other);
    writeFileSync(join(other, 'package.json'), PACKAGE_JSON);
    const before = folderState(other);

    await withApp(async (app, window) => {
      await pick(app, window, join(other, 'package.json'));
      await expectRefusalNaming(window, 'package.json');
      await window.locator('.alert-dialog-btn-ok').click();
      await expect(window.locator('.current-project-info')).toHaveCount(0);
      expect(await recents(window)).toEqual([]);
    });

    expect(folderState(other)).toEqual(before);
  });

  test('un project.json sans name ni type : refusé sans trace ; un vrai projet s’ouvre juste après', async () => {
    const root = tempRoot();
    const foreign = makeProject(root, 'Outil', {});
    writeFileSync(foreign.projectJson, '{"theme":"dark","targets":{}}\n');
    const before = folderState(foreign.dir);
    const real = makeProject(root, 'Vrai', { id: 'v', name: 'Vrai', type: 'article', createdAt: new Date().toISOString() });

    await withApp(async (app, window) => {
      await pick(app, window, foreign.projectJson);
      await expectRefusalNaming(window, 'project.json');
      await window.locator('.alert-dialog-btn-ok').click();
      expect(await recents(window)).toEqual([]);

      await openProject(app, window, real, 'Vrai');
      expect(await recents(window)).toEqual([real.projectJson]);
    });

    expect(folderState(foreign.dir)).toEqual(before);
    expect(existsSync(join(foreign.dir, '.cliodeck'))).toBe(false);
  });

  test('le faux refus : sans type, sans name, avec un BOM, ou `Project.json` sur un disque sans casse, le projet s’ouvre', async () => {
    const root = tempRoot();
    const noType = makeProject(root, 'SansType', { name: 'Ancienne thèse' });
    const noName = makeProject(root, 'SansNom', { type: 'article' });
    // Le BOM d'un éditeur Windows : un vrai projet, et le fichier le garde.
    const withBom = makeProject(root, 'AvecBom', {});
    writeFileSync(withBom.projectJson, `\uFEFF${JSON.stringify({ name: 'Bloc-notes', type: 'article' })}`);
    // Le manifeste s'appelle `Project.json` sur le disque.
    const shouting = makeProject(root, 'Casse', {});
    rmSync(shouting.projectJson);
    const chosenSpelling = join(shouting.dir, 'Project.json');
    writeFileSync(chosenSpelling, JSON.stringify({ name: 'Casse', type: 'article' }));
    // Disque sans casse : les deux noms sont un seul fichier, le cas de macOS et de Windows.
    const caseInsensitive = existsSync(shouting.projectJson);

    await withApp(async (app, window) => {
      await openProject(app, window, noType, 'SansType');
      await expect(window.locator('.project-meta')).toContainText('Ancienne thèse');
      await openProject(app, window, noName, 'SansNom');
      await expect(window.locator('.project-meta')).toContainText(noName.dir);
      await openProject(app, window, withBom, 'AvecBom');
      await expect(window.locator('.project-meta')).toContainText('Bloc-notes');
      if (caseInsensitive) {
        await pick(app, window, chosenSpelling);
        await expect(editor(window)).toContainText('Casse', { timeout: 20_000 });
        await expect(window.locator('.project-meta')).toContainText(shouting.dir);
        // Les récents gardent le nom que relit tout le code.
        expect(await recents(window)).toContain(shouting.projectJson);
        expect(await recents(window)).not.toContain(chosenSpelling);
      }
    });
    expect(JSON.parse(readFileSync(noType.projectJson, 'utf8')).lastOpenedAt).toEqual(expect.any(String));
    const bomBytes = readFileSync(withBom.projectJson);
    expect(bomBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(JSON.parse(bomBytes.subarray(3).toString('utf8')).lastOpenedAt).toEqual(expect.any(String));
  });
});

test.describe('au démarrage, des récents laissés par l’ancienne ouverture', () => {
  test.setTimeout(120_000);

  test('aucun dialogue, le fichier qui n’est pas un projet sort de la liste, le project.json à réparer reste caché', async () => {
    const root = tempRoot();
    const strayDir = join(root, 'Bibliographie');
    mkdirSync(strayDir);
    const stray = join(strayDir, 'references.json');
    writeFileSync(stray, CSL_JSON);
    const repairable = makeProject(root, 'Réparable', {});
    writeFileSync(repairable.projectJson, '{"chapters":[]}\n');
    const real = makeProject(root, 'Vrai', { id: 'v', name: 'Vrai', type: 'article', createdAt: new Date().toISOString() });
    const strayBefore = folderState(strayDir);
    const repairableBefore = folderState(repairable.dir);
    const realBefore = folderState(real.dir);

    const userDataDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-manifeste-recents-'));
    roots.push(userDataDir);
    // En tête de liste, là où la rouvrirait un démarrage automatique.
    writeFileSync(
      join(userDataDir, 'cliodeck-config.json'),
      JSON.stringify({ language: 'fr', recentProjects: [stray, repairable.projectJson, real.projectJson] }),
    );

    await withApp(
      async (_app, window) => {
        await expect.poll(() => recents(window), { timeout: 15_000 }).toEqual([repairable.projectJson, real.projectJson]);
        const section = window.getByRole('button', { name: /Projets récents/ });
        await expect(section).toHaveCount(1, { timeout: 10_000 });
        await section.click();
        await expect(window.locator('.recent-project-path')).toHaveText([real.dir]);
        // Le démarrage n'ouvre rien, et ne pose aucune question au premier écran.
        await expect(window.locator('.alert-dialog-message')).toHaveCount(0);
        await expect(window.locator('.current-project-info')).toHaveCount(0);
      },
      { userDataDir },
    );

    expect(folderState(strayDir)).toEqual(strayBefore);
    expect(folderState(repairable.dir)).toEqual(repairableBefore);
    expect(folderState(real.dir)).toEqual(realBefore);
  });
});
