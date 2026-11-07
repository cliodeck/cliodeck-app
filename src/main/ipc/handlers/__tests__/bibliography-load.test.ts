/**
 * `bibliography:load` et `load-with-metadata` disent ce qui ne s'est pas lu (S07-1-11, S07-1-10).
 *
 * Un `.bib` absent ou illisible répondait succès avec 0 citation, et des métadonnées illisibles
 * passaient pour absentes : le panneau se montrait vide, ou sans PDF, sans un mot. Vrai handler,
 * vrai service, vrais fichiers ; seul le projet courant du main est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), projectPath: '' }));

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
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

import { setupBibliographyHandlers } from '../bibliography-handlers.js';

type LoadResponse = {
  success: boolean;
  citations: Array<{ id: string; zoteroAttachments?: unknown[] }>;
  unreadKeys?: string[];
  metadataUnreadable?: boolean;
  problem?: string;
  reason?: string;
};

const loadWithMetadata = (file: string) =>
  h.handlers.get('bibliography:load-with-metadata')!({}, { filePath: path.join(h.projectPath, file), projectPath: h.projectPath }) as Promise<LoadResponse>;
const load = (file: string) => h.handlers.get('bibliography:load')!({}, path.join(h.projectPath, file)) as Promise<LoadResponse>;

const GARDE = '@book{Garde_2000,\n  title = {Le temps des archives},\n  zoterokey = {GARD2000},\n}\n';
const metadataPath = () => path.join(h.projectPath, '.cliodeck', 'bibliography-metadata.json');

beforeEach(() => {
  h.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-bib-load-'));
  fs.mkdirSync(path.join(h.projectPath, '.cliodeck'));
  h.handlers.clear();
  setupBibliographyHandlers();
});

afterEach(() => {
  fs.rmSync(h.projectPath, { recursive: true, force: true });
});

describe('bibliography:load-with-metadata', () => {
  it('.bib absent : un échec qui le dit, pas une bibliographie vide', async () => {
    expect(await loadWithMetadata('renomme.bib')).toMatchObject({ success: false, citations: [], problem: 'missing' });
  });

  it('.bib pas en UTF-8 : illisible, avec sa raison', async () => {
    fs.writeFileSync(path.join(h.projectPath, 'b.bib'), Buffer.from('@book{Etat,\n  title = {L’État},\n}\n', 'latin1'));

    expect(await loadWithMetadata('b.bib')).toMatchObject({ success: false, problem: 'unreadable', reason: 'encoding' });
  });

  it('entrées non lues et métadonnées illisibles : la liste, et ce qui manque', async () => {
    fs.writeFileSync(path.join(h.projectPath, 'b.bib'), `${GARDE}\n@misc{entretien_dupont,\n  note = {Entretien},\n}\n`);
    fs.writeFileSync(metadataPath(), '{"version": 2, "citations": {"GARD');

    const result = await loadWithMetadata('b.bib');

    expect(result).toMatchObject({ success: true, unreadKeys: ['entretien_dupont'], metadataUnreadable: true });
    expect(result.citations.map((c) => c.id)).toEqual(['Garde_2000']);
    // Le fichier abîmé reste tel quel : rien ne le réécrit à la lecture.
    expect(fs.readFileSync(metadataPath(), 'utf8')).toBe('{"version": 2, "citations": {"GARD');
  });

  it('témoin : tout se lit, rien ne manque', async () => {
    fs.writeFileSync(path.join(h.projectPath, 'b.bib'), GARDE);
    fs.writeFileSync(
      metadataPath(),
      JSON.stringify({ version: 2, lastUpdated: 'x', citations: { GARD2000: { id: 'Garde_2000', zoteroKey: 'GARD2000', zoteroAttachments: [{ key: 'att' }] } } })
    );

    const result = await loadWithMetadata('b.bib');

    expect(result).toMatchObject({ success: true, unreadKeys: [], metadataUnreadable: false });
    expect(result.citations[0]?.zoteroAttachments).toHaveLength(1);
  });
});

describe('bibliography:load', () => {
  it('.bib absent : un échec qui le dit', async () => {
    expect(await load('renomme.bib')).toMatchObject({ success: false, citations: [], problem: 'missing' });
  });

  it('les entrées non lues sont rendues', async () => {
    fs.writeFileSync(path.join(h.projectPath, 'b.bib'), `${GARDE}\n@misc{sans_titre,\n  note = {x},\n}\n`);

    expect(await load('b.bib')).toMatchObject({ success: true, unreadKeys: ['sans_titre'] });
  });
});
