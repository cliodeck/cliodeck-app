/**
 * Illisible n'est pas absent, dans la vraie app : le preload, les vrais handlers, le vrai disque,
 * dossiers temporaires uniquement.
 *
 * Une virgule en trop dans `.cliodeck/config.json`, ou un projet passé par une version plus
 * récente : le fichier était remplacé par une configuration vide, et le coffre et les serveurs
 * MCP disparaissaient (S11-1-8). Un disque débranché retirait ses projets des récents (S11-2-8).
 * Jugé sur les octets des fichiers.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { launchApp } from './_helpers/launch';

const CONFIG_ON_DISK = {
  schema_version: 2,
  name: 'Projet E2E',
  vault: { path: '/Volumes/Notes/Obsidian' },
  mcpClients: [{ name: 'europeana', transport: 'sse', url: 'http://127.0.0.1:9/sse' }],
  mcpServer: { enabled: true },
  security: { sourceInspectorMode: 'block' },
};
const VALID_CONFIG = JSON.stringify(CONFIG_ON_DISK, null, 2);
/** Une virgule en trop, comme après une retouche à la main. */
const TRAILING_COMMA = `${VALID_CONFIG.slice(0, -2)},\n}\n`;
const NEWER_SCHEMA = VALID_CONFIG.replace('"schema_version": 2', '"schema_version": 3');

interface ProjectOnDisk {
  root: string;
  dir: string;
  projectJson: string;
  configJson: string;
  documentMd: string;
}

const projects: ProjectOnDisk[] = [];

function makeProject(name = 'Projet', config?: string, parent = 'parent'): ProjectOnDisk {
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-config-'));
  const dir = join(root, parent, name);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  const projectJson = join(dir, 'project.json');
  writeFileSync(
    projectJson,
    JSON.stringify({
      id: `00000000-0000-4000-8000-${String(projects.length).padStart(12, '0')}`,
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const documentMd = join(dir, 'document.md');
  writeFileSync(documentMd, `# ${name}\n`);
  const configJson = join(dir, '.cliodeck', 'config.json');
  if (config !== undefined) writeFileSync(configJson, config);
  const project = { root, dir, projectJson, configJson, documentMd };
  projects.push(project);
  return project;
}

test.afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true });
});

async function pickProject(app: ElectronApplication, window: Page, projectJson: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
}

async function openProject(app: ElectronApplication, window: Page, project: ProjectOnDisk): Promise<void> {
  await pickProject(app, window, project.projectJson);
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(basename(project.dir), {
    timeout: 20_000,
  });
}

const configToast = (window: Page) =>
  window.locator('.status-toast', { hasText: 'Réglages du projet illisibles' });

async function openMcpClients(window: Page): Promise<void> {
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('show-settings-modal')));
  await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeVisible({ timeout: 15_000 });
  await window.getByRole('button', { name: 'Expert', exact: true }).click();
  await window.getByRole('button', { name: /Clients MCP/i }).first().click();
}

/** Le formulaire de la section, avec ses vrais gestes ; rend le message de refus qui s'affiche. */
async function addMcpServerRefused(window: Page, wording: string): Promise<void> {
  await window.getByRole('button', { name: 'Ajouter un client' }).click();
  await window.getByPlaceholder('mon-serveur').fill('nouveau');
  await window.locator('select.config-input').first().selectOption('sse');
  await window.getByPlaceholder('https://example.com/mcp/sse').fill('http://127.0.0.1:9/sse');
  await window.getByRole('button', { name: 'Enregistrer & démarrer' }).click();
  await expect(window.getByText(wording, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
}

async function openBrainstormDrawer(window: Page): Promise<void> {
  await window.locator('.workspace-mode-bar button', { hasText: 'Brainstormer' }).click();
  await window.getByRole('button', { name: /Contexte du projet/i }).first().click();
}

async function withApp(
  run: (app: ElectronApplication, window: Page, userDataDir: string) => Promise<void>,
  options: { userDataDir?: string; keepUserData?: boolean } = {},
): Promise<void> {
  const outcome = await launchApp({ userDataDir: options.userDataDir });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  try {
    await run(app, window, userDataDir);
  } finally {
    await app.close().catch(() => undefined);
    if (!options.keepUserData) rmSync(userDataDir, { recursive: true, force: true });
  }
}

test.describe('config.json illisible', () => {
  test.setTimeout(120_000);

  for (const [label, content, wording, sectionWording, avoid] of [
    ['virgule en trop', TRAILING_COMMA, 'Corrigez ce fichier', 'ne se lit pas', 'Mettez ClioDeck à jour'],
    ['schema_version 3', NEWER_SCHEMA, 'Mettez ClioDeck à jour', 'Mettez ClioDeck à jour', 'Corrigez ce fichier'],
  ] as const) {
    test(`${label} : le projet s’ouvre, l’auteur le sait, et le fichier reste identique à l’octet`, async () => {
      const project = makeProject('Projet', content);
      const before = readFileSync(project.configJson);

      await withApp(async (app, window) => {
        await openProject(app, window, project);

        const toast = configToast(window);
        await expect(toast).toHaveCount(1, { timeout: 10_000 });
        await expect(toast).toContainText('.cliodeck/config.json');
        await expect(toast).toContainText("n'a pas été modifié");
        await expect(toast).toContainText('coffre Obsidian');
        await expect(toast).toContainText('MCP');
        await expect(toast).toContainText('Avertir');
        await expect(toast).toContainText(wording);
        await expect(toast).not.toContainText(avoid);
        await expect(toast).not.toContainText(/invalid_json|newer_schema/);
        expect(readFileSync(project.configJson).equals(before)).toBe(true);

        // Le mode choisi (`block`) n'est plus lu : c'est ce que dit le message.
        const mode = await window.evaluate(() => window.electron.fusion.security.getMode());
        expect(mode).toMatchObject({ success: true, mode: 'warn' });

        // Le tiroir du Brainstorm : le motif, pas « vérification… » sans fin.
        await openBrainstormDrawer(window);
        await expect(window.locator('.brainstorm-panel').getByText(sectionWording).first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(window.getByText('vérification…')).toHaveCount(0);
        await window.locator('.workspace-mode-bar button', { hasText: 'Écrire' }).click();

        await openMcpClients(window);
        await addMcpServerRefused(window, sectionWording);
        await window.screenshot({
          path: join(process.env.E2E_SHOTS ?? tmpdir(), `config-${label.replace(/\W+/g, '-')}.png`),
        });
        await window.keyboard.press('Escape');

        expect(readFileSync(project.configJson).equals(before)).toBe(true);
      });

      // La fermeture non plus n'écrit rien.
      expect(readFileSync(project.configJson).equals(before)).toBe(true);
    });
  }

  test('fichier réparé, projet rouvert : plus de message, et l’ajout repart de ce que dit le fichier', async () => {
    const project = makeProject('Projet', TRAILING_COMMA);

    await withApp(async (app, window) => {
      await openProject(app, window, project);
      await expect(configToast(window)).toHaveCount(1, { timeout: 10_000 });

      writeFileSync(project.configJson, VALID_CONFIG);
      await pickProject(app, window, project.projectJson);
      await expect(configToast(window)).toHaveCount(0, { timeout: 15_000 });

      const status = await window.evaluate(() => window.electron.fusion.vault.status());
      expect(status).toMatchObject({ success: true, vaultPath: '/Volumes/Notes/Obsidian' });
      expect(JSON.parse(readFileSync(project.configJson, 'utf8')).mcpClients).toEqual(CONFIG_ON_DISK.mcpClients);
    });
  });

  test('un config.json de 0 octet : comme absent, aucun message', async () => {
    const project = makeProject('Projet', '');

    await withApp(async (app, window) => {
      await openProject(app, window, project);
      await expect(configToast(window)).toHaveCount(0);
      const status = await window.evaluate(() => window.electron.fusion.vault.status());
      expect(status).toMatchObject({ success: true, vaultPath: null });
    });
  });
});

test.describe('projets récents', () => {
  test.setTimeout(150_000);

  const listed = async (window: Page): Promise<string[]> => {
    await expect(window.locator('button[title="Ouvrir un projet"]').first()).toBeVisible({ timeout: 20_000 });
    const section = window.getByRole('button', { name: /Projets récents/ });
    await expect(section).toHaveCount(1, { timeout: 10_000 });
    if ((await window.locator('.recent-project-item').count()) === 0) await section.click();
    return window.locator('.recent-project-path').allTextContents();
  };

  const recents = (window: Page) =>
    window.evaluate(() => window.electron.project.getRecent()) as Promise<string[]>;

  test('dossier parent renommé : caché, entrée conservée ; nom rendu : il revient et s’ouvre', async () => {
    const away = makeProject('Disque');
    const stays = makeProject('Local');
    const moved = makeProject('PlusDeManifeste');
    const blank = makeProject('ManifesteVide');
    const parent = dirname(away.dir);
    const parked = `${parent}-debranche`;
    const userDataDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-recents-'));
    writeFileSync(join(userDataDir, 'cliodeck-config.json'), JSON.stringify({ language: 'fr' }));

    try {
      await withApp(
        async (app, window) => {
          for (const project of [away, moved, blank, stays]) await openProject(app, window, project);
          expect(await recents(window)).toHaveLength(4);
        },
        { userDataDir, keepUserData: true },
      );

      // Le disque débranché ; un manifeste vidé par une écriture interrompue ; un autre retiré à la main.
      renameSync(parent, parked);
      writeFileSync(blank.projectJson, '');
      const blankBefore = readFileSync(blank.projectJson);
      rmSync(moved.projectJson);

      await withApp(
        async (_app, window) => {
          await expect
            .poll(() => listed(window), { timeout: 15_000 })
            .toEqual([stays.dir]);
          const after = await recents(window);
          expect(after).toContain(away.projectJson);
          expect(after).toContain(blank.projectJson);
          expect(after).toContain(stays.projectJson);
          // Le dossier est là, le fichier n'y est plus : la seule absence avérée.
          expect(after).not.toContain(moved.projectJson);
        },
        { userDataDir, keepUserData: true },
      );
      expect(readFileSync(blank.projectJson).equals(blankBefore)).toBe(true);

      renameSync(parked, parent);

      await withApp(
        async (_app, window) => {
          await expect
            .poll(() => listed(window), { timeout: 15_000 })
            .toEqual(expect.arrayContaining([away.dir, stays.dir]));
          expect(await recents(window)).toContain(away.projectJson);

          await window.locator('.recent-project-item', { hasText: away.dir }).locator('.recent-project-content').click();
          await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Disque', { timeout: 20_000 });
        },
        { userDataDir, keepUserData: true },
      );
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
      // Rendu en cas d'échec avant l'étape : la suppression du dossier temporaire le couvre.
      if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    }
  });

  test('lien project.json cassé : indisponible, jamais retiré', async () => {
    const volume = makeProject('Volume');
    const linked = makeProject('Lie');
    const target = join(volume.dir, 'manifeste.json');
    renameSync(linked.projectJson, target);
    symlinkSync(target, linked.projectJson);
    const userDataDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-lien-'));
    writeFileSync(join(userDataDir, 'cliodeck-config.json'), JSON.stringify({ language: 'fr' }));

    try {
      await withApp(
        async (app, window) => {
          await openProject(app, window, linked);
          await openProject(app, window, volume);
        },
        { userDataDir, keepUserData: true },
      );

      rmSync(target);

      await withApp(
        async (_app, window) => {
          await expect.poll(() => listed(window), { timeout: 15_000 }).toEqual([volume.dir]);
          expect(await recents(window)).toContain(linked.projectJson);
        },
        { userDataDir, keepUserData: true },
      );
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

test('projet B au project.json invalide : A reste ouvert et s’écrit, et le message se lit', async () => {
  test.setTimeout(120_000);
  const a = makeProject('ProjetA');
  const b = makeProject('ProjetB');
  writeFileSync(b.projectJson, '{ "name": "ProjetB", }');
  const before = readFileSync(b.projectJson);

  await withApp(async (app, window) => {
    await openProject(app, window, a);

    await pickProject(app, window, b.projectJson);
    const message = window.locator('#alert-dialog-message');
    await expect(message).toHaveText(
      "Ce projet n'a pas pu être ouvert. Son fichier project.json est peut-être illisible ou endommagé.",
      { timeout: 15_000 },
    );
    await window.locator('.alert-dialog-btn-ok').click();

    expect(readFileSync(b.projectJson).equals(before)).toBe(true);
    expect(await window.evaluate(() => window.electron.project.getRecent())).toEqual([a.projectJson]);

    // A n'a pas été fermé : son texte est là, et la frappe suivante s'écrit dans son fichier.
    await expect(window.locator('.codemirror-editor .cm-content')).toContainText('ProjetA');
    await window.locator('.codemirror-editor .cm-content').click();
    await window.keyboard.press('Meta+End');
    await window.keyboard.type('Encore A.');
    await window.keyboard.press('Meta+S');
    await expect.poll(() => readFileSync(a.documentMd, 'utf8'), { timeout: 10_000 }).toContain('Encore A.');
  });
});
