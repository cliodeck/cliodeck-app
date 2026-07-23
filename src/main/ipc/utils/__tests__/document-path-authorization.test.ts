/**
 * Autorisation des chemins de documents — la combinaison exacte que
 * `editor:load-file` / `editor:save-file` appliquent désormais : validateur
 * de chemins d'abord, registre de consentement en repli.
 *
 * Le test reproduit la garde plutôt que d'importer le handler, qui exige un
 * runtime Electron complet (ipcMain, BrowserWindow). Les deux briques
 * combinées sont les mêmes.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nonexistent-app-path' },
}));

const projectPathRef = { current: null as string | null };
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: {
    getCurrentProjectPath: () => projectPathRef.current,
  },
}));

const { validateReadPath, validateWritePath } = await import('../path-validator');
const { rememberConsentedPath, isConsentedPath, __resetConsentedPaths } = await import(
  '../user-consented-paths'
);

/** Réplique de `authorizeDocumentPath` (editor-handlers.ts). */
async function authorize(filePath: string, intent: 'read' | 'write'): Promise<string> {
  try {
    return intent === 'read'
      ? await validateReadPath(filePath)
      : await validateWritePath(filePath);
  } catch (error) {
    if (await isConsentedPath(filePath)) return path.resolve(filePath);
    throw error;
  }
}

let tmpRoot: string;
let projectDir: string;
let ailleurs: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-docauth-'));
  projectDir = path.join(tmpRoot, 'projet');
  ailleurs = path.join(tmpRoot, 'ailleurs');
  await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
  await mkdir(ailleurs, { recursive: true });
  await writeFile(path.join(projectDir, 'chapters', '01.md'), '# Chapitre un');
  await writeFile(path.join(ailleurs, 'externe.md'), '# Document externe');
  projectPathRef.current = projectDir;
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  __resetConsentedPaths();
});

describe('chemins du projet', () => {
  it('autorise la lecture d’un chapitre du manuscrit', async () => {
    const p = path.join(projectDir, 'chapters', '01.md');
    expect(await authorize(p, 'read')).toBe(p);
  });

  it('autorise l’écriture d’un chapitre du manuscrit', async () => {
    const p = path.join(projectDir, 'chapters', '02.md');
    expect(await authorize(p, 'write')).toBe(p);
  });
});

describe('chemins hors projet — refus par défaut', () => {
  it('refuse la lecture de ~/.ssh/id_rsa', async () => {
    const cle = path.join(os.homedir(), '.ssh', 'id_rsa');
    await expect(authorize(cle, 'read')).rejects.toThrow(/access denied/i);
  });

  it('refuse l’écriture de ~/.zshrc', async () => {
    const rc = path.join(os.homedir(), '.zshrc');
    await expect(authorize(rc, 'write')).rejects.toThrow(/access denied/i);
  });

  it('refuse un document hors projet non consenti', async () => {
    await expect(authorize(path.join(ailleurs, 'externe.md'), 'read')).rejects.toThrow(
      /access denied/i
    );
  });
});

describe('chemins hors projet — après consentement natif', () => {
  it('autorise la lecture d’un document choisi dans le dialogue', async () => {
    const externe = path.join(ailleurs, 'externe.md');
    await rememberConsentedPath(externe);
    expect(await authorize(externe, 'read')).toBe(externe);
  });

  it('autorise l’enregistrement vers une destination choisie (Enregistrer sous)', async () => {
    const cible = path.join(ailleurs, 'copie.md');
    await rememberConsentedPath(cible);
    expect(await authorize(cible, 'write')).toBe(cible);
  });

  it('le consentement ne déborde pas sur les fichiers voisins', async () => {
    await rememberConsentedPath(path.join(ailleurs, 'externe.md'));
    await writeFile(path.join(ailleurs, 'voisin.md'), 'x');
    await expect(authorize(path.join(ailleurs, 'voisin.md'), 'read')).rejects.toThrow(
      /access denied/i
    );
  });

  it('consentir à un document ne donne pas accès à ~/.ssh', async () => {
    await rememberConsentedPath(path.join(ailleurs, 'externe.md'));
    await expect(
      authorize(path.join(os.homedir(), '.ssh', 'id_rsa'), 'read')
    ).rejects.toThrow(/access denied/i);
  });
});
