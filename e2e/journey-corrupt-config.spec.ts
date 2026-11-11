/**
 * Un fichier de réglages illisible n'empêche plus l'app de s'ouvrir sans un mot (S11-1-10).
 *
 * electron-store lit `cliodeck-config.json` et `cliodeck-secrets.json` dans son constructeur, et un
 * JSON invalide y lève : `configManager.init` rejetait dans `whenReady`, avant `createWindow`.
 * L'app tournait sans fenêtre, l'icône du Dock inerte, et le rejet n'allait qu'au journal des
 * plantages. Une virgule en trop, laissée en éditant le fichier à la main, suffisait.
 *
 * Le fichier est mis de côté (`<nom>.illisible-<horodatage>`, octets d'origine), l'app s'ouvre avec
 * les défauts, et un message nomme la copie. Un fichier illisible pour une autre raison (droits)
 * n'est pas touché : une boîte d'erreur, puis l'app sort, au lieu de rester en vie sans fenêtre.
 *
 * Les dialogues du démarrage partent avant que le pilote puisse appeler `app.evaluate` : un module
 * chargé par `-r` les simule (`_helpers/stub-startup-dialogs.cjs`). Tout se passe dans un userData
 * temporaire, jamais dans les réglages de l'auteur.
 */

import { test, expect } from '@playwright/test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, shouldSkip, startElectron, startupDialogs } from './_helpers/launch';

const LOCALES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'locales');
const menuText = (key: string): string =>
  (JSON.parse(readFileSync(join(LOCALES, 'fr', 'menu.json'), 'utf8')) as Record<string, string>)[key];

/** Une virgule en trop, laissée en éditant le fichier à la main. */
const BROKEN_CONFIG = '{\n  "language": "fr",\n  "lastDialogDirectory": "/tmp",\n}\n';

const toClean: string[] = [];

test.afterEach(() => {
  for (const dir of toClean.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userData(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-reglages-'));
  toClean.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const copiesOf = (dir: string, name: string) => readdirSync(dir).filter((n) => n.startsWith(`${name}.illisible-`));

test('cliodeck-config.json illisible (virgule en trop) : la fenêtre s’ouvre, la copie garde les octets, et le message la nomme', async () => {
  const dir = userData({ 'cliodeck-config.json': BROKEN_CONFIG });
  const outcome = await launchApp({ userDataDir: dir, startupDialogs: true });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window } = outcome.value;
  try {
    await expect(window.locator('.workspace-mode-bar')).toBeVisible({ timeout: 20_000 });

    const copies = copiesOf(dir, 'cliodeck-config.json');
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe(BROKEN_CONFIG);
    // Le fichier neuf se lit : le prochain lancement ne repasse pas par là.
    expect(() => JSON.parse(readFileSync(join(dir, 'cliodeck-config.json'), 'utf8'))).not.toThrow();

    const seen = startupDialogs(dir);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'message', type: 'warning', message: menuText('settingsRecoveredTitle') });
    const detail = seen[0].kind === 'message' ? (seen[0].detail ?? '') : '';
    expect(detail).toContain(copies[0]);
    expect(detail).not.toContain('{{');
  } finally {
    await app.close();
  }
});

test('cliodeck-secrets.json illisible : la fenêtre s’ouvre, et le message nomme la copie et dit que les clés sont à ressaisir', async () => {
  const brokenSecrets = '{"zotero.apiKey": "djEw",,}';
  const dir = userData({ 'cliodeck-config.json': JSON.stringify({ language: 'fr' }), 'cliodeck-secrets.json': brokenSecrets });
  const outcome = await launchApp({ userDataDir: dir, startupDialogs: true });
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window } = outcome.value;
  try {
    await expect(window.locator('.workspace-mode-bar')).toBeVisible({ timeout: 20_000 });

    const copies = copiesOf(dir, 'cliodeck-secrets.json');
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0]), 'utf8')).toBe(brokenSecrets);
    // La configuration, elle, était lisible : rien de mis de côté, la langue est restée.
    expect(copiesOf(dir, 'cliodeck-config.json')).toEqual([]);

    const seen = startupDialogs(dir);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'message', message: menuText('settingsRecoveredTitle') });
    const detail = seen[0].kind === 'message' ? (seen[0].detail ?? '') : '';
    // Le chemin réel du fichier mis de côté (`/var` est un lien vers `/private/var` sous macOS).
    expect(detail).toBe(menuText('settingsRecoveredSecrets').replace('{{path}}', join(realpathSync(dir), copies[0])));
  } finally {
    await app.close();
  }
});

test('cliodeck-config.json sans droit de lecture : une boîte d’erreur, puis l’app sort, sans fenêtre et sans rien renommer', async () => {
  const skip = shouldSkip();
  test.skip(skip !== null, skip ?? '');
  test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'chmod 000 n’ôte pas la lecture ici.');
  const content = JSON.stringify({ language: 'fr' });
  const dir = userData({ 'cliodeck-config.json': content });
  const file = join(dir, 'cliodeck-config.json');
  chmodSync(file, 0o000);
  try {
    const app = await startElectron(dir, { startupDialogs: true });
    let windows = 0;
    app.on('window', () => {
      windows += 1;
    });
    const exitCode = new Promise<number | null>((done) => {
      const child = app.process();
      if (child.exitCode !== null) done(child.exitCode);
      else child.once('exit', (code) => done(code));
    });
    // Sans le correctif, l'app restait en vie sans fenêtre : le délai le dit, sans bloquer la suite.
    const code = await Promise.race([exitCode, new Promise<'en vie'>((done) => setTimeout(done, 30_000, 'en vie'))]);
    if (code === 'en vie') await app.close().catch(() => undefined);

    expect(code).toBe(1);
    expect(windows).toBe(0);
    const seen = startupDialogs(dir);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'error', title: menuText('settingsUnreadableTitle') });
    expect(seen[0].kind === 'error' ? seen[0].content : '').toContain('EACCES');
    expect(copiesOf(dir, 'cliodeck-config.json')).toEqual([]);
  } finally {
    if (existsSync(file)) chmodSync(file, 0o644);
  }
  expect(readFileSync(file, 'utf8')).toBe(content);
});
