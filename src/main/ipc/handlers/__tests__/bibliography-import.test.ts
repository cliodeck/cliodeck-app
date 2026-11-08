/**
 * Importer un `.bib` dans le projet ouvert (S07-1-3) : « Fusionner » écrit la fusion dans le `.bib`
 * du projet, « Remplacer » y met le fichier importé, et rien n'est écrasé sans copie de sécurité.
 *
 * Avant, la fusion n'existait qu'en mémoire. Le renderer copiait ensuite le fichier importé dans le
 * projet sous son nom (`fs:copy-file`, qui écrase), puis repointait `project.json` sur lui en
 * effaçant la collection Zotero. Hors du projet, la copie était refusée, consentement du dialogue
 * compris ; un homonyme rangé dans un sous-dossier écrasait le `.bib` du projet. Le main, lui, ne
 * connaissait plus que les références importées : exports et aperçu ne résolvaient plus les autres.
 *
 * Vrai handler, vrai service, vrai `projectManager`, vrais fichiers, dans des projets temporaires.
 * La source rangée hors du projet est choisie par le vrai `dialog:open-file`, qui l'inscrit au
 * registre de consentement ; seul le dialogue natif est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** Ce que l'auteur choisit dans le dialogue natif. */
  chosen: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [h.chosen] }) },
  shell: {},
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => '/nulle-part' },
}));
vi.mock('../../../services/config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: () => [],
    get: () => undefined,
    set: () => undefined,
  },
}));
vi.mock('../../../services/reading-notes-indexing.js', () => ({ indexReadingNotesInBackground: () => undefined }));

import { setupBibliographyHandlers } from '../bibliography-handlers.js';
import { setupFilesystemHandlers } from '../filesystem-handlers.js';
import { bibliographyService, bibBackupPath } from '../../../services/bibliography-service.js';
import { projectManager } from '../../../services/project-manager.js';
import { __resetConsentedPaths } from '../../utils/user-consented-paths.js';
import { BibTeXParser } from '../../../../../backend/core/bibliography/BibTeXParser.js';

interface ImportResponse {
  success: boolean;
  error?: string;
  bibPath?: string;
  total?: number;
  newCitations?: number;
  duplicates?: number;
  unreadKeys?: string[];
  sourceSaved?: boolean;
  problem?: string;
  reason?: string;
  file?: string;
}

const entry = (id: string, title: string, extra = '') =>
  `@book{${id},\n  title = {${title}},\n  author = {Garde, Anne},\n  year = {2000},${extra}\n}\n`;
/** Le `.bib` du projet : une notice de Zotero, une ajoutée à la main. */
const PROJET = `${entry('Garde_2000', 'Le temps des archives', '\n  zoterokey = {GARD2000},')}\n${entry('Main_2010', 'Une note à la main')}`;
/** Celui d'un collègue : la même notice Zotero, et une autre. */
const COLLEGUE = `${entry('Garde_2000', 'Le temps des archives', '\n  zoterokey = {GARD2000},')}\n${entry('Autre_2015', 'Un autre livre')}`;
const SOURCE = { type: 'zotero', filePath: 'bibliography.bib', zoteroCollection: 'COLL1234' };

let projectDir = '';
let outside = '';
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const projectJson = () => path.join(projectDir, 'project.json');
const manifest = () => JSON.parse(fs.readFileSync(projectJson(), 'utf8')) as Record<string, unknown>;
const projectBib = () => path.join(projectDir, 'bibliography.bib');
const idsOf = (file: string) => new BibTeXParser().parse(fs.readFileSync(file, 'utf8')).map((c) => c.id);

/** Un projet ouvert pour de vrai, avec sa bibliographie synchronisée depuis Zotero. */
async function openProject(options: { bibliographySource?: object | null; bib?: string | null } = {}): Promise<void> {
  projectDir = tempDir('cliodeck-bib-import-');
  fs.mkdirSync(path.join(projectDir, '.cliodeck'));
  const source = options.bibliographySource === undefined ? SOURCE : options.bibliographySource;
  fs.writeFileSync(
    projectJson(),
    JSON.stringify(
      {
        id: '00000000-0000-4000-8000-000000000055',
        name: 'Thèse',
        type: 'article',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...(source ? { bibliographySource: source, zotero: { collectionKey: 'COLL1234' } } : {}),
      },
      null,
      2
    )
  );
  const bib = options.bib === undefined ? PROJET : options.bib;
  if (bib !== null) fs.writeFileSync(projectBib(), bib);
  expect((await projectManager.loadProject(projectJson())).success).toBe(true);
  if (bib !== null) await bibliographyService.loadFromFile(projectBib());
}

/** Le fichier choisi dans le dialogue natif, que le vrai `dialog:open-file` inscrit au registre de consentement. */
async function choose(sourcePath: string): Promise<void> {
  h.chosen = sourcePath;
  await h.handlers.get('dialog:open-file')!({}, { filters: [{ name: 'BibTeX', extensions: ['bib'] }] });
}

/** L'import d'un fichier déjà choisi. */
async function importChosen(sourcePath: string, mode: 'merge' | 'replace', expectedProjectPath = projectDir): Promise<ImportResponse> {
  return (await h.handlers.get('bibliography:import')!({}, { sourcePath, mode, expectedProjectPath })) as ImportResponse;
}

/** Ce que fait le bouton : le dialogue natif, puis l'import du fichier choisi. */
async function importBib(sourcePath: string, mode: 'merge' | 'replace', expectedProjectPath = projectDir): Promise<ImportResponse> {
  await choose(sourcePath);
  return importChosen(sourcePath, mode, expectedProjectPath);
}

/** Un fichier rangé dans les Téléchargements de l'auteur, hors du projet. */
function downloaded(name: string, content: string | Buffer): string {
  const file = path.join(outside, name);
  fs.writeFileSync(file, content);
  return file;
}

/** Un fichier rangé dans un sous-dossier du projet. */
function inSubfolder(name: string, content: string): string {
  const dir = path.join(projectDir, 'import');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

beforeEach(() => {
  h.handlers.clear();
  __resetConsentedPaths();
  setupBibliographyHandlers();
  setupFilesystemHandlers();
  outside = tempDir('cliodeck-telechargements-');
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('« Fusionner » : la fusion est écrite dans le .bib du projet', () => {
  it('source consentie hors du projet, de même nom : le .bib du projet contient l’union, et le total est celui du disque', async () => {
    await openProject();
    const source = downloaded('bibliography.bib', COLLEGUE);

    const result = await importBib(source, 'merge');

    expect(result).toMatchObject({ success: true, newCitations: 1, duplicates: 1, total: 3, unreadKeys: [] });
    expect(idsOf(projectBib())).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
    expect(result.total).toBe(idsOf(projectBib()).length);
    // La source reste telle qu'elle est.
    expect(fs.readFileSync(source, 'utf8')).toBe(COLLEGUE);
  });

  it('homonyme rangé dans un sous-dossier du projet : il n’écrase rien, la fusion est écrite', async () => {
    await openProject();
    const source = inSubfolder('bibliography.bib', COLLEGUE);

    const result = await importBib(source, 'merge');

    expect(result).toMatchObject({ success: true, total: 3 });
    expect(idsOf(projectBib())).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
    // L'état d'avant, à l'octet, dans la copie de sécurité.
    expect(fs.readFileSync(bibBackupPath(projectDir), 'utf8')).toBe(PROJET);
  });

  it('le projet garde sa source et sa collection Zotero', async () => {
    await openProject();
    const source = inSubfolder('refs.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, sourceSaved: true });

    expect(manifest().bibliographySource).toEqual(SOURCE);
    expect(manifest().zotero).toEqual({ collectionKey: 'COLL1234' });
    expect(fs.existsSync(path.join(projectDir, 'refs.bib'))).toBe(false);
  });

  it('le main connaît l’union : exports et aperçu résolvent les clés du projet et celles du fichier', async () => {
    await openProject();
    const source = downloaded('collegue.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toMatchObject({ success: true });

    expect(bibliographyService.getCitations().map((c) => c.id)).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
    expect(bibliographyService.getByCitationKey('Main_2010')?.title).toBe('Une note à la main');
  });

  it('projet sans bibliographie : un bibliography.bib neuf, que project.json retient', async () => {
    await openProject({ bibliographySource: null, bib: null });
    const source = downloaded('collegue.bib', COLLEGUE);

    const result = await importBib(source, 'merge');

    expect(result).toMatchObject({ success: true, total: 2, newCitations: 2, sourceSaved: true });
    expect(idsOf(projectBib())).toEqual(['Garde_2000', 'Autre_2015']);
    expect(manifest().bibliographySource).toEqual({ type: 'file', filePath: 'bibliography.bib' });
  });

  it('une entrée du .bib du projet ne se lit pas : la fusion s’arrête sans rien écrire, et dit laquelle', async () => {
    const partial = `${PROJET}\n@misc{entretien_dupont,\n  note = {Entretien},\n}\n`;
    await openProject({ bib: partial });
    const before = fs.readFileSync(projectJson(), 'utf8');
    const source = inSubfolder('refs.bib', COLLEGUE);

    const result = await importBib(source, 'merge');

    expect(result).toMatchObject({ success: false, error: 'bib-unread', file: 'bibliography.bib', unreadKeys: ['entretien_dupont'] });
    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(partial);
    expect(fs.existsSync(bibBackupPath(projectDir))).toBe(false);
    expect(fs.readFileSync(projectJson(), 'utf8')).toBe(before);
  });

  it('rien de nouveau : le .bib n’est pas réécrit, et la copie de sécurité garde ce qu’elle gardait', async () => {
    await openProject();
    const source = downloaded('collegue.bib', entry('Garde_2000', 'Le temps des archives', '\n  zoterokey = {GARD2000},'));
    const mtime = fs.statSync(projectBib()).mtimeMs;

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 0, duplicates: 1, total: 2 });

    expect(fs.statSync(projectBib()).mtimeMs).toBe(mtime);
    expect(fs.existsSync(bibBackupPath(projectDir))).toBe(false);
  });

  it('project.json ne se lit plus : on ne sait pas où fusionner, rien n’est écrit', async () => {
    await openProject();
    fs.writeFileSync(projectJson(), '{ "name": "Thèse", }');
    const source = inSubfolder('refs.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toEqual({ success: false, error: 'project-unreadable' });

    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
    expect(fs.existsSync(bibBackupPath(projectDir))).toBe(false);
  });

  it('deux fusions lancées ensemble dans le même .bib (l’import relancé pendant le premier) : le fichier garde l’une et l’autre', async () => {
    await openProject();
    const first = downloaded('collegue.bib', entry('Autre_2015', 'Un autre livre'));
    const second = downloaded('seminaire.bib', entry('Tiers_2020', 'Un troisième livre'));
    await choose(first);
    await choose(second);

    // Sans le verrou du .bib, chacune relisait l'état d'avant l'autre, et la dernière écrite effaçait la première.
    const results = await Promise.all([importChosen(first, 'merge'), importChosen(second, 'merge')]);

    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect([...idsOf(projectBib())].sort()).toEqual(['Autre_2015', 'Garde_2000', 'Main_2010', 'Tiers_2020']);
    expect(bibliographyService.getCitations()).toHaveLength(4);
  });

  it('les entrées non lues de la source sont rendues, et seules les autres sont fusionnées', async () => {
    await openProject();
    const source = downloaded('collegue.bib', `${COLLEGUE}\n@misc{sans_titre,\n  note = {Rien},\n}\n`);

    const result = await importBib(source, 'merge');

    expect(result).toMatchObject({ success: true, unreadKeys: ['sans_titre'], total: 3 });
  });
});

describe('« Remplacer » : le fichier importé entre dans le projet sans rien écraser sans copie', () => {
  it('homonyme rangé dans un sous-dossier : la copie de sécurité garde l’ancien .bib à l’octet, le nouveau est brut', async () => {
    await openProject();
    // Un `@comment` de JabRef : le contenu brut, pas réexporté, le garde.
    const raw = `@comment{jabref-meta: databaseType:bibtex;}\n\n${COLLEGUE}`;
    const source = inSubfolder('bibliography.bib', raw);

    const result = await importBib(source, 'replace');

    expect(result).toMatchObject({ success: true, total: 2, sourceSaved: true });
    expect(fs.readFileSync(bibBackupPath(projectDir), 'utf8')).toBe(PROJET);
    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(raw);
    expect(manifest().bibliographySource).toEqual(SOURCE);
  });

  it('source consentie hors du projet, de même nom : copie de sécurité, puis le fichier importé', async () => {
    await openProject();
    const source = downloaded('bibliography.bib', COLLEGUE);

    expect(await importBib(source, 'replace')).toMatchObject({ success: true, total: 2 });

    expect(fs.readFileSync(bibBackupPath(projectDir), 'utf8')).toBe(PROJET);
    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(COLLEGUE);
    expect(bibliographyService.getCitations().map((c) => c.id)).toEqual(['Garde_2000', 'Autre_2015']);
  });

  it('source d’un autre nom : le projet pointe sur elle, et garde sa collection Zotero', async () => {
    await openProject();
    const source = downloaded('collegue.bib', COLLEGUE);

    const result = await importBib(source, 'replace');

    expect(result).toMatchObject({ success: true, bibPath: path.join(projectDir, 'collegue.bib') });
    expect(fs.readFileSync(path.join(projectDir, 'collegue.bib'), 'utf8')).toBe(COLLEGUE);
    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
    expect(manifest().bibliographySource).toEqual({ ...SOURCE, filePath: 'collegue.bib' });
  });

  it('dans le projet, ce nom est un lien vers un fichier rangé dehors : rien n’est écrit, ni dehors ni dans la copie de sécurité', async () => {
    await openProject();
    // Une bibliographie maîtresse commune à plusieurs projets, ou un lien venu avec un projet partagé.
    const shared = path.join(tempDir('cliodeck-bibliotheque-commune-'), 'maitresse.bib');
    const MAITRESSE = entry('Maitre_1990', 'La bibliographie commune');
    fs.writeFileSync(shared, MAITRESSE);
    fs.symlinkSync(shared, path.join(projectDir, 'refs.bib'));
    const source = downloaded('refs.bib', COLLEGUE);

    const result = await importBib(source, 'replace');

    expect(result).toEqual({ success: false, error: 'bib-outside-project', file: 'refs.bib' });
    expect(fs.readFileSync(shared, 'utf8')).toBe(MAITRESSE);
    expect(fs.existsSync(bibBackupPath(projectDir))).toBe(false);
    expect(manifest().bibliographySource).toEqual(SOURCE);
    expect(bibliographyService.getCitations().map((c) => c.id)).toEqual(['Garde_2000', 'Main_2010']);
  });

  it('le .bib du projet lui-même : rien n’est écrit, pas de copie de sécurité', async () => {
    await openProject();
    const mtime = fs.statSync(projectBib()).mtimeMs;

    expect(await importBib(projectBib(), 'replace')).toMatchObject({ success: true, total: 2 });

    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
    expect(fs.statSync(projectBib()).mtimeMs).toBe(mtime);
    expect(fs.existsSync(bibBackupPath(projectDir))).toBe(false);
  });
});

describe('ce qui n’entre pas dans le projet', () => {
  it('source pas en UTF-8 : rien n’est écrit, et la raison est rendue', async () => {
    await openProject();
    const source = downloaded('latin1.bib', Buffer.from('@book{Etat,\n  title = {L’État},\n}\n', 'latin1'));

    expect(await importBib(source, 'replace')).toMatchObject({ success: false, problem: 'unreadable', reason: 'encoding' });

    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
    expect(fs.existsSync(path.join(projectDir, 'latin1.bib'))).toBe(false);
    // Le main garde la bibliographie du projet.
    expect(bibliographyService.getByCitationKey('Main_2010')).toBeDefined();
  });

  it('projet changé depuis le clic : refusé, rien n’est écrit', async () => {
    await openProject();
    const source = inSubfolder('refs.bib', COLLEGUE);
    const elsewhere = tempDir('cliodeck-autre-projet-');

    expect(await importBib(source, 'merge', elsewhere)).toEqual({ success: false, error: 'project-changed' });

    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
    expect(manifest().bibliographySource).toEqual(SOURCE);
  });

  it('témoin : un fichier hors du projet qui n’a pas été choisi dans le dialogue reste illisible', async () => {
    await openProject();
    const source = downloaded('collegue.bib', COLLEGUE);

    const result = (await h.handlers.get('bibliography:import')!(
      {},
      { sourcePath: source, mode: 'merge', expectedProjectPath: projectDir }
    )) as ImportResponse;

    expect(result.success).toBe(false);
    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(PROJET);
  });
});
