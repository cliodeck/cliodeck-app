/**
 * Les serveurs MCP d'un projet démarrent à son ouverture (A10, S09-1-2). Un projet rouvert n'en avait
 * aucun : seuls les projets créés dans la session chargeaient leurs serveurs, la barre d'état n'avait
 * pas d'indicateur MCP, et le chat aucun outil.
 *
 * L'app réelle, des projets temporaires, et le mini-serveur MCP du dépôt lancé par le Node de ce
 * test, par son chemin absolu : jamais `npx`, aucun réseau. Les accords se retiennent dans le userData
 * temporaire de `launchApp`, jamais dans celui de l'auteur. Le test accepte lui-même la question du
 * projet A, reconnue à son texte et à ses arguments ; toute autre question est refusée.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, leaveDialogs } from './_helpers/launch';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO_ROOT, 'backend/integrations/mcp-clients/__tests__/fixtures/mini-mcp-server.mjs');
const QUESTION = 'Ce projet déclare le serveur MCP « mini ». Le démarrer ?';
/** L'argument que porte la copie « reçue » : une autre empreinte, jamais acceptée. */
const CHANGED_ARG = '--outils=2';

const toClean: string[] = [];
let pidLog = '';

test.afterEach(() => {
  // Filet, par PID et jamais par motif : un serveur qui survivrait au test.
  for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pids = (): number[] =>
  pidLog && existsSync(pidLog) ? readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number) : [];
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeManifest(dir: string, name: string, id: string): void {
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      id: `00000000-0000-4000-8000-0000000000${id}`,
      name,
      type: 'article',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'document.md'), `# ${name}\n\nTexte du projet ${name}.\n`);
}

/** Un projet article dont `.cliodeck/config.json` déclare le mini-serveur. */
function makeProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.cliodeck'), { recursive: true });
  writeManifest(dir, name, 'a1');
  writeFileSync(
    join(dir, '.cliodeck', 'config.json'),
    JSON.stringify(
      {
        schema_version: 2,
        name,
        mcpClients: [{ name: 'mini', transport: 'stdio', command: process.execPath, args: [SERVER, pidLog] }],
      },
      null,
      2,
    ),
  );
  return join(dir, 'project.json');
}

/** La copie de A « reçue d'un tiers » : un argument du serveur changé dans son config.json. */
function receivedCopy(projectJson: string, name: string): string {
  const from = dirname(projectJson);
  const to = join(dirname(from), name);
  cpSync(from, to, { recursive: true });
  // Son propre nom et son propre texte : l'écran dit lequel des deux est ouvert.
  writeManifest(to, name, 'b2');
  const config = join(to, '.cliodeck', 'config.json');
  const parsed = JSON.parse(readFileSync(config, 'utf8')) as { mcpClients: Array<{ args: string[] }> };
  parsed.mcpClients[0].args.push(CHANGED_ARG);
  writeFileSync(config, JSON.stringify(parsed, null, 2));
  return join(to, 'project.json');
}

/**
 * Accepte la question du serveur de A, reconnue à son texte et à ses arguments, et la compte. Les
 * autres passent au bouchon de `launchApp`, qui les refuse et les inscrit (`leaveDialogs`).
 */
async function acceptServerOfA(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }, { question, changed }) => {
    const store = globalThis as unknown as { __acceptedMcp: string[] };
    store.__acceptedMcp = [];
    const previous = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => Promise<unknown>;
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
      const options = args[args.length - 1] as { message?: string; detail?: string };
      if (options.message === question && !options.detail?.includes(changed)) {
        store.__acceptedMcp.push(options.message);
        return { response: 1, checkboxChecked: false };
      }
      return previous(...args);
    };
  }, { question: QUESTION, changed: CHANGED_ARG });
}

const accepted = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __acceptedMcp: string[] }).__acceptedMcp.slice());

async function openProject(app: ElectronApplication, window: Page, projectJson: string, text: string): Promise<void> {
  await window.locator('#left-tab-projects').click();
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, projectJson);
  await window.locator('button[title="Ouvrir un projet"]').first().click();
  await expect(window.locator('.codemirror-editor .cm-content')).toContainText(text, { timeout: 20_000 });
}

const mcpIndicator = (window: Page) => window.locator('.status-bar__item', { hasText: /^MCP \d+\/\d+$/ });

test('un serveur accepté redémarre à la réouverture, sans question ; la copie modifiée la repose ; rien ne survit à la sortie', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-mcp-ouverture-'));
  toClean.push(root);
  pidLog = join(root, 'pids.txt');
  const projectA = makeProject(root, 'Projet A');
  const projectB = receivedCopy(projectA, 'Projet B');

  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  toClean.push(userDataDir);
  let closed = false;

  try {
    await acceptServerOfA(app);

    // 1. Première ouverture de A : la question, acceptée ; le serveur démarre.
    await openProject(app, window, projectA, 'Texte du projet Projet A.');
    await expect(mcpIndicator(window)).toHaveText('MCP 1/1', { timeout: 15_000 });
    expect(await accepted(app)).toEqual([QUESTION]);
    expect(pids()).toHaveLength(1);
    expect(alive(pids()[0])).toBe(true);

    // 2. « Fermer le projet » : le serveur s'arrête.
    await window.getByRole('button', { name: 'Fermer le projet' }).click();
    await expect.poll(() => alive(pids()[0]), { timeout: 10_000 }).toBe(false);

    // 3. Rouvert depuis « Projets récents » : aucune question, le serveur est prêt.
    if (!(await window.locator('.recent-project-content').count())) {
      await window.getByText('Projets récents').click();
    }
    await window.locator('.recent-project-content', { hasText: dirname(projectA) }).click();
    await expect(window.locator('.codemirror-editor .cm-content')).toContainText('Texte du projet Projet A.', {
      timeout: 20_000,
    });
    await expect(mcpIndicator(window)).toHaveText('MCP 1/1', { timeout: 15_000 });
    expect(await accepted(app)).toEqual([QUESTION]);
    expect(await leaveDialogs(app)).toEqual([]);
    expect(pids()).toHaveLength(2);
    expect(alive(pids()[1])).toBe(true);

    // 4. B, la copie dont un argument a changé : le serveur de A s'arrête, une question, refusée ;
    //    rien ne démarre, et l'indicateur ne garde pas le serveur de A.
    await openProject(app, window, projectB, 'Texte du projet Projet B.');
    await expect(window.locator('.status-bar__item--project')).toHaveText('Projet B', { timeout: 15_000 });
    await expect.poll(async () => (await leaveDialogs(app)).map((d) => [d.message, d.response]), { timeout: 15_000 }).toEqual([
      [QUESTION, 0],
    ]);
    await expect.poll(() => alive(pids()[1]), { timeout: 10_000 }).toBe(false);
    await expect(mcpIndicator(window)).toHaveCount(0);
    expect(pids()).toHaveLength(2);

    // 5. Rouvrir A, puis quitter l'app avec son serveur lancé : aucun processus ne survit.
    await openProject(app, window, projectA, 'Texte du projet Projet A.');
    await expect(mcpIndicator(window)).toHaveText('MCP 1/1', { timeout: 15_000 });
    expect(await accepted(app)).toEqual([QUESTION]);
    expect(pids()).toHaveLength(3);
    await app.close();
    closed = true;
    await expect.poll(() => pids().filter(alive), { timeout: 10_000 }).toEqual([]);
  } finally {
    if (!closed) await app.close();
  }
});
