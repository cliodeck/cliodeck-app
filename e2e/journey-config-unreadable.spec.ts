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
  lstatSync,
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

/** Le corps des Réglages : le message d'ouverture, lui, dit déjà « ne se lit pas » à côté. */
const settingsBody = (window: Page) => window.locator('.settings-body');

/**
 * Le formulaire de la section, avec ses vrais gestes. Rend quand la réponse du main est arrivée :
 * le bouton se réactive alors. Le formulaire ne se ferme que sur un ajout réussi.
 */
async function submitNewMcpServer(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Ajouter un client' }).click();
  await window.getByPlaceholder('mon-serveur').fill('nouveau');
  await window.locator('.config-field', { hasText: 'Transport' }).locator('select').selectOption('sse');
  await window.getByPlaceholder('https://example.com/mcp/sse').fill('http://127.0.0.1:9/sse');
  const save = window.getByRole('button', { name: 'Enregistrer & démarrer' });
  await save.click();
  await expect(save).toBeEnabled({ timeout: 10_000 });
  await expect(window.getByPlaceholder('mon-serveur')).toHaveValue('nouveau');
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
        await expect(toast).toContainText('vault Obsidian');
        await expect(toast).toContainText("notes déjà indexées restent consultées par l'assistant");
        await expect(toast).not.toContainText('vault Obsidian et les serveurs MCP');
        await expect(toast).toContainText('MCP');
        await expect(toast).toContainText('Avertir');
        await expect(toast).toContainText(wording);
        await expect(toast).not.toContainText(avoid);
        await expect(toast).not.toContainText(/invalid_json|newer_schema/);
        expect(readFileSync(project.configJson).equals(before)).toBe(true);

        // Le mode choisi (`block`) n'est plus lu, et `warn` s'applique : c'est ce que dit le message.
        const mode = await window.evaluate(() => window.electron.fusion.security.getMode());
        expect(mode).toMatchObject({ success: false, appliedMode: 'warn' });

        // Le tiroir du Brainstorm : le motif, pas « vérification… » sans fin.
        await openBrainstormDrawer(window);
        await expect(window.locator('.brainstorm-panel').getByText(sectionWording).first()).toBeVisible({
          timeout: 10_000,
        });
        await expect(window.getByText('vérification…')).toHaveCount(0);
        await window.locator('.workspace-mode-bar button', { hasText: 'Écrire' }).click();

        await openMcpClients(window);
        const body = settingsBody(window);
        // Ce fichier déclare un serveur : « aucun client » serait faux.
        await expect(body.getByText(sectionWording, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
        await expect(body.getByText('Aucun client MCP configuré')).toHaveCount(0);
        // Il dit aussi `block` : aucun choix affiché pour l'auteur, et ce qui s'applique est écrit.
        await expect(body.locator('input[name="inspector-mode"]:checked')).toHaveCount(0);
        await expect(body.locator('input[name="inspector-mode"]:disabled')).toHaveCount(3);
        await expect(body.getByText("c'est le mode « Avertir » qui s'applique", { exact: false })).toBeVisible();

        await submitNewMcpServer(window);
        await expect(body.getByText(sectionWording, { exact: false }).first()).toBeVisible();
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

  test('fichier abîmé une fois la section ouverte : l’ajout est refusé, et le motif apparaît', async () => {
    const project = makeProject('Projet', JSON.stringify({ schema_version: 2, name: 'Projet E2E' }, null, 2));

    await withApp(async (app, window) => {
      await openProject(app, window, project);
      await expect(configToast(window)).toHaveCount(0);
      await openMcpClients(window);
      const body = settingsBody(window);
      const empty = body.getByText('Aucun client MCP configuré');
      await expect(empty).toBeVisible({ timeout: 10_000 });

      writeFileSync(project.configJson, '{ "schema_version": 2, }');
      const before = readFileSync(project.configJson);
      const reason = body.getByText('ne se lit pas', { exact: false });
      await expect(reason).toHaveCount(0);

      await submitNewMcpServer(window);

      await expect(reason).toHaveCount(1);
      // À côté du bouton : en haut de la section, le formulaire le poussait hors de la vue. Pas la
      // seule position à l'écran : ce robot remplit le formulaire en quelques millisecondes, et une
      // section plus haut finit parfois de se charger après son clic. Tout descend alors d'environ
      // 230 px (mesuré), le bouton et le motif avec. Qui regarde le bouton voit le motif.
      expect(await reason.evaluate((line) => line.nextElementSibling?.textContent)).toContain('Enregistrer & démarrer');
      const save = window.getByRole('button', { name: 'Enregistrer & démarrer' });
      await expect(async () => {
        await save.scrollIntoViewIfNeeded();
        await expect(reason).toBeInViewport({ timeout: 500 });
      }).toPass({ timeout: 10_000 });
      await expect(empty).toHaveCount(0);
      expect(readFileSync(project.configJson).equals(before)).toBe(true);
    });
  });

  test('config.json lien cassé : le projet s’ouvre, l’auteur le sait, et rien n’est écrit à l’autre bout', async () => {
    const project = makeProject('Projet');
    const target = join(project.root, 'volume-absent', 'config.json');
    symlinkSync(target, project.configJson);

    await withApp(async (app, window) => {
      await openProject(app, window, project);
      await expect(configToast(window)).toHaveCount(1, { timeout: 10_000 });

      const status = await window.evaluate(() => window.electron.fusion.vault.status());
      expect(status).toMatchObject({ success: false });
      const server = await window.evaluate(() => window.electron.fusion.mcpServer.get());
      expect(server).toMatchObject({ success: false });
      expect(String(server.error)).not.toContain('.tmp');
    });

    expect(lstatSync(project.configJson).isSymbolicLink()).toBe(true);
    expect(existsSync(dirname(target))).toBe(false);
  });

  test('config.json évincé par iCloud : le projet s’ouvre, l’auteur le sait, et rien ne s’écrit à côté', async () => {
    const project = makeProject('Projet');
    const placeholder = join(dirname(project.configJson), '.config.json.icloud');
    writeFileSync(placeholder, 'bplist00');

    await withApp(async (app, window) => {
      await openProject(app, window, project);

      await expect(configToast(window)).toHaveCount(1, { timeout: 10_000 });
      expect(existsSync(project.configJson)).toBe(false);
      expect(readFileSync(placeholder, 'utf8')).toBe('bplist00');

      const status = await window.evaluate(() => window.electron.fusion.vault.status());
      expect(status).toMatchObject({ success: false });
      expect(existsSync(project.configJson)).toBe(false);
    });
  });

  test('fichier réparé, projet rouvert : plus de message, le coffre se relit, et les serveurs sont restés sur le disque', async () => {
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

test('dossier parent renommé pendant la session : aucun squelette recréé, et le dossier reprend son nom', async () => {
  test.setTimeout(120_000);
  const project = makeProject('Projet', VALID_CONFIG);
  const parent = dirname(project.dir);
  const parked = `${parent}-debranche`;
  const documentBefore = readFileSync(project.documentMd);
  const configBefore = readFileSync(project.configJson);

  await withApp(async (app, window) => {
    await openProject(app, window, project);
    const editor = window.locator('.codemirror-editor .cm-content');
    await editor.click();
    await window.keyboard.press('Meta+End');
    await window.keyboard.type('Avant.');

    renameSync(parent, parked);

    const save = window.locator('button.toolbar-btn[title="Enregistrer"]').first();
    const saveRefused = async (): Promise<void> => {
      await save.click();
      await expect(window.locator('#alert-dialog-message')).toHaveText('Erreur lors de la sauvegarde du fichier', {
        timeout: 10_000,
      });
      await window.locator('.alert-dialog-btn-ok').click();
      await expect(window.locator('#alert-dialog-message')).toHaveCount(0);
    };

    await saveRefused();
    expect(existsSync(parent)).toBe(false);

    // Le geste qui recréait le squelette : ouvrir les Réglages en mode Expert, sans rien y faire.
    await openMcpClients(window);
    await expect(
      settingsBody(window).getByText('le dossier du projet est introuvable', { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
    expect(existsSync(parent)).toBe(false);
    await window.keyboard.press('Escape');
    await expect(window.getByRole('heading', { name: 'Paramètres' })).toBeHidden({ timeout: 10_000 });

    // L'enregistrement suivant écrivait dans ce squelette, loin du vrai document.
    await saveRefused();
    expect(existsSync(parent)).toBe(false);

    // Le nom se rend, ce que ENOTEMPTY empêchait, et le texte tapé part dans le vrai fichier.
    renameSync(parked, parent);
    expect(readFileSync(project.documentMd).equals(documentBefore)).toBe(true);
    expect(readFileSync(project.configJson).equals(configBefore)).toBe(true);
    await save.click();
    await expect.poll(() => readFileSync(project.documentMd, 'utf8'), { timeout: 10_000 }).toContain('Avant.');
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

test.describe('project.json refuse une écriture demandée depuis un panneau', () => {
  test.setTimeout(120_000);

  const manifest = (project: ProjectOnDisk) =>
    JSON.parse(readFileSync(project.projectJson, 'utf8')) as Record<string, unknown> & { zotero?: unknown };

  test('Paramètres Zotero : la collection d’une synchronisation reste, ce qu’on vide s’efface, et le refus se lit', async () => {
    const project = makeProject('ProjetZ');
    writeFileSync(
      project.projectJson,
      JSON.stringify({ ...manifest(project), zotero: { collectionKey: 'AVANT', groupId: '1' } }, null, 2),
    );

    await withApp(async (app, window) => {
      await openProject(app, window, project);
      await window.getByText('Parametres Zotero').click();
      const group = window.getByPlaceholder("Entrez l'ID du groupe Zotero");
      const collection = window.getByPlaceholder('Entrez la cle de collection (optionnel)');
      await expect(collection).toHaveValue('AVANT');
      const save = window.locator('.config-section', { has: collection }).getByRole('button', { name: 'Enregistrer' });

      // Une synchronisation pose une autre collection pendant que le panneau est ouvert.
      writeFileSync(
        project.projectJson,
        JSON.stringify({ ...manifest(project), zotero: { collectionKey: 'SYNCHRO', groupId: '1' } }, null, 2),
      );
      await group.fill('42');
      await save.click();
      await expect.poll(() => manifest(project).zotero, { timeout: 10_000 }).toEqual({
        collectionKey: 'SYNCHRO',
        groupId: '42',
      });

      // Vider le champ passe par le vrai IPC : `undefined` y arrive, et efface.
      await collection.fill('');
      await save.click();
      await expect.poll(() => manifest(project).zotero, { timeout: 10_000 }).toEqual({ groupId: '42' });

      const broken = '{ "name": "ProjetZ", }';
      writeFileSync(project.projectJson, broken);
      await group.fill('43');
      await save.click();
      await expect(window.locator('.save-message.error')).toContainText('Non enregistré', { timeout: 10_000 });
      await expect(window.locator('.save-message.error')).toContainText('project.json');
      expect(readFileSync(project.projectJson, 'utf8')).toBe(broken);

      // Dans son cadre, sous le bouton : le panneau est étroit, et le message long.
      const refusal = await window.locator('.save-message.error').boundingBox();
      const frame = await window.locator('.config-section', { has: collection }).boundingBox();
      const button = await save.boundingBox();
      expect(refusal && frame && button).toBeTruthy();
      if (refusal && frame && button) {
        expect(refusal.x).toBeGreaterThanOrEqual(frame.x);
        expect(refusal.x + refusal.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(refusal.y).toBeGreaterThanOrEqual(button.y + button.height);
      }
    });
  });

  test('import d’un .bib : l’auteur lit que project.json ne l’a pas retenu, et le fichier reste à l’octet', async () => {
    const project = makeProject('ProjetBib');
    // Dans le projet : hors de lui, `fs:copy-file` refuse d'abord (S11-1-9, à venir dans L05-5).
    const bib = join(project.dir, 'import', 'refs.bib');
    mkdirSync(dirname(bib));
    writeFileSync(bib, '@book{braudel1949,\n  title={La Méditerranée},\n  author={Braudel, Fernand},\n  year={1949}\n}\n');

    await withApp(async (app, window) => {
      await openProject(app, window, project);

      const broken = '{ "name": "ProjetBib", }';
      writeFileSync(project.projectJson, broken);
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, bib);
      await window.locator('#left-tab-bibliography').click();
      await window.locator('button[title="Importer fichier BibTeX"]').click();

      const message = window.locator('#alert-dialog-message');
      await expect(message).toContainText('La bibliographie est chargée', { timeout: 15_000 });
      await expect(message).toContainText("project.json n'a pas été modifié");
      expect(readFileSync(project.projectJson, 'utf8')).toBe(broken);
    });
  });
});
