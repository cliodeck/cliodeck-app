/**
 * Étiqueter une note de lecture qu'on ne sait pas lire : le refus remonte avec sa raison.
 *
 * Sans elle, le renderer ne peut pas dire quoi faire d'une note qui n'est pas en UTF-8,
 * refusée à l'ouverture et, depuis, à la réécriture.
 *
 * Vrai handler sur un vrai dossier ; seuls le projet courant du main et les services
 * sans rapport sont simulés.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  projectPath: '' as string,
  indexed: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/nulle-part' },
}));
vi.mock('../../../services/project-manager.js', () => ({
  projectManager: { getCurrentProjectPath: () => h.projectPath },
}));
vi.mock('../../../services/bibliography-service.js', () => ({ bibliographyService: {} }));
vi.mock('../../../services/reading-notes-indexing.js', () => ({
  indexReadingNotesInBackground: (why: string) => h.indexed.push(why),
}));

import { setupBibliographyHandlers } from '../bibliography-handlers.js';

const setTags = (tags: string[]) =>
  h.handlers.get('bibliography:reading-notes:set-tags')!(
    {},
    { citekey: 'dupont2020', title: 'Un titre', tags }
  ) as Promise<{ success: boolean; note?: { tags: string[] }; code?: string; reason?: string; error?: string }>;

describe('bibliography:reading-notes:set-tags', () => {
  beforeEach(() => {
    h.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-notes-ipc-'));
    h.indexed = [];
    h.handlers.clear();
    setupBibliographyHandlers();
  });

  afterEach(() => {
    fs.rmSync(h.projectPath, { recursive: true, force: true });
  });

  it('note en Latin-1 : refus avec sa raison, fichier intact, rien à réindexer', async () => {
    const dir = path.join(h.projectPath, 'reading-notes');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'dupont2020.md');
    const bytes = Buffer.from("---\ncitekey: dupont2020\n---\n\nL'évêque a été reçu.\n", 'latin1');
    fs.writeFileSync(file, bytes);

    const response = await setTags(['lu']);

    expect(response).toMatchObject({ success: false, code: 'unreadable', reason: 'encoding' });
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(h.indexed).toEqual([]);
  });

  it('témoin : note en UTF-8, l’étiquette est écrite', async () => {
    const response = await setTags(['lu']);

    expect(response).toMatchObject({ success: true, note: { tags: ['lu'] } });
    expect(fs.readFileSync(path.join(h.projectPath, 'reading-notes', 'dupont2020.md'), 'utf8')).toContain('- lu');
  });

  it('une autre erreur reste une erreur sans raison : un front matter cassé n’est pas un encodage', async () => {
    const dir = path.join(h.projectPath, 'reading-notes');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'dupont2020.md'), '---\ntags: [non fermé\n---\nTexte\n');

    const response = await setTags(['lu']);

    expect(response.success).toBe(false);
    expect(response.reason).toBeUndefined();
    expect(response.error).toMatch(/illisible/);
  });
});
