/**
 * Un projet disparu (parent renommé, volume débranché) n'est jamais recréé en squelette.
 *
 * Les écrivains créaient leur dossier par un `mkdir` récursif : le projet ouvert dont le dossier
 * venait d'être renommé renaissait, vide, à son ancien chemin, avec la seule note ou le seul fichier
 * de métadonnées qu'on venait d'écrire, loin du vrai projet. Le refus porte un code que l'interface
 * traduit (`project_root_missing`), et rien n'est écrit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureReadingNote, setProjectTags } from '../../bibliography/readingNotes.js';
import { BibliographyMetadataService } from '../../../services/BibliographyMetadataService.js';
import type { Citation } from '../../../types/citation.js';

const braudel = { citekey: 'Braudel_1949', zoteroKey: 'ABCD1234', title: 'La Méditerranée' };

const citation = {
  id: 'Braudel_1949',
  zoteroKey: 'ABCD1234',
  zoteroAttachments: [{ key: 'ATT1', filename: 'braudel.pdf', contentType: 'application/pdf', downloaded: false }],
} as unknown as Citation;

let workDir: string;
let project: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'cliodeck-racine-'));
  project = path.join(workDir, 'Thèse');
  mkdirSync(project);
  writeFileSync(path.join(project, 'project.json'), '{"name":"Thèse"}');
  // Le dossier parent est renommé pendant que le projet est ouvert : son chemin n'existe plus.
  renameSync(project, path.join(workDir, 'Thèse (ancienne)'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('le dossier du projet a disparu : rien n’est recréé', () => {
  it('ouvrir une note de lecture : refusé par son code, aucun squelette', async () => {
    await expect(ensureReadingNote(project, braudel)).rejects.toMatchObject({ code: 'project_root_missing' });
    expect(existsSync(project)).toBe(false);
  });

  it('poser des étiquettes : refusé par son code, aucun squelette', async () => {
    await expect(setProjectTags(project, braudel, ['Méditerranée'])).rejects.toMatchObject({
      code: 'project_root_missing',
    });
    expect(existsSync(project)).toBe(false);
  });

  // Le rattachement seul. L'interface télécharge toujours avant de rattacher : le parcours entier,
  // téléchargement compris, est jugé dans `src/main/services/__tests__/zotero-download-root.test.ts`.
  it('rattacher un PDF téléchargé : refusé par son code, aucun .cliodeck', async () => {
    await expect(
      BibliographyMetadataService.patchAttachment(project, citation, 'ATT1', path.join(project, 'PDFs', 'b.pdf'))
    ).rejects.toMatchObject({ code: 'project_root_missing' });
    expect(existsSync(project)).toBe(false);
  });

  it('écrire ce que la synchronisation a lu : refusé par son code, aucun .cliodeck', async () => {
    await expect(BibliographyMetadataService.saveFromSync(project, [citation])).rejects.toMatchObject({
      code: 'project_root_missing',
    });
    expect(existsSync(project)).toBe(false);
  });

  it('témoin : le projet en place, la note s’écrit', async () => {
    renameSync(path.join(workDir, 'Thèse (ancienne)'), project);
    await expect(ensureReadingNote(project, braudel)).resolves.toContain('Braudel_1949.md');
  });
});
