/**
 * Registre des chemins consentis (route dédiée prescrite par
 * `path-validator.ts:12-15`).
 *
 * L'enjeu : autoriser l'ouverture d'un document rangé hors du projet sans
 * rouvrir l'accès à tout le système de fichiers. Seul un chemin issu d'un
 * dialogue natif — donc désigné par l'utilisateur — doit être accepté.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  rememberConsentedPath,
  isConsentedPath,
  __resetConsentedPaths,
} from '../user-consented-paths.js';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cliodeck-consent-'));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  __resetConsentedPaths();
});

afterAll(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('registre des chemins consentis', () => {
  it('refuse par défaut : rien n’est accessible sans consentement', async () => {
    expect(await isConsentedPath('/etc/hosts')).toBe(false);
    expect(await isConsentedPath(path.join(process.env.HOME ?? '/root', '.ssh/id_rsa'))).toBe(false);
  });

  it('accepte un chemin après passage par le dialogue natif', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'memoire.md');
    await writeFile(file, '# Mémoire\n', 'utf-8');

    expect(await isConsentedPath(file)).toBe(false);
    await rememberConsentedPath(file);
    expect(await isConsentedPath(file)).toBe(true);
  });

  it('ne consent qu’au fichier choisi, pas à son dossier', async () => {
    const dir = await tempDir();
    const chosen = path.join(dir, 'choisi.md');
    const voisin = path.join(dir, 'voisin.md');
    await writeFile(chosen, 'a', 'utf-8');
    await writeFile(voisin, 'b', 'utf-8');

    await rememberConsentedPath(chosen);
    expect(await isConsentedPath(chosen)).toBe(true);
    // Un renderer compromis ne doit pas déduire un droit sur le voisinage.
    expect(await isConsentedPath(voisin)).toBe(false);
    expect(await isConsentedPath(dir)).toBe(false);
  });

  it('normalise les chemins équivalents (segments relatifs)', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'notes.md');
    await writeFile(file, 'x', 'utf-8');
    await rememberConsentedPath(file);

    const detour = path.join(dir, 'sous', '..', 'notes.md');
    expect(await isConsentedPath(detour)).toBe(true);
  });

  it('reconnaît un chemin consenti atteint via un lien symbolique', async () => {
    const dir = await tempDir();
    const cible = path.join(dir, 'cible.md');
    const lien = path.join(dir, 'lien.md');
    await writeFile(cible, 'contenu', 'utf-8');
    await symlink(cible, lien);

    // L'utilisateur a désigné le lien ; la forme réelle est mémorisée aussi.
    await rememberConsentedPath(lien);
    expect(await isConsentedPath(lien)).toBe(true);
    expect(await isConsentedPath(cible)).toBe(true);
  });

  it('accepte une destination « Enregistrer sous » qui n’existe pas encore', async () => {
    const dir = await tempDir();
    const futur = path.join(dir, 'pas-encore-ecrit.md');

    await rememberConsentedPath(futur);
    expect(await isConsentedPath(futur)).toBe(true);
  });

  it('ignore les entrées vides', async () => {
    await rememberConsentedPath('');
    expect(await isConsentedPath('')).toBe(false);
  });
});
