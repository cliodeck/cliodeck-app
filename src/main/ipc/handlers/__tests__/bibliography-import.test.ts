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
import { fileURLToPath } from 'url';

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
import { auditParsedBib } from '../../../../../backend/core/bibliography/bibAudit.js';

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

  // La fusion réécrit le .bib : un PDF du projet y passe en relatif, celui d'un collègue rangé
  // ailleurs garde son chemin (S07-2-1).
  it('la réécriture range relatif au .bib le PDF du projet, et garde absolu celui rangé ailleurs', async () => {
    await openProject();
    // Tel qu'une ancienne synchronisation l'a écrit : le chemin absolu du PDF téléchargé.
    fs.writeFileSync(projectBib(), PROJET.replace('year = {2000},', () => `year = {2000},\n  file = {${projectDir}/PDFs/Garde.pdf},`));
    const source = downloaded('collegue.bib', entry('Autre_2015', 'Un autre livre', '\n  file = {/Users/collegue/PDFs/Autre.pdf},'));

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 1 });

    const written = fs.readFileSync(projectBib(), 'utf8');
    expect(written).toContain('file = {PDFs/Garde.pdf}');
    expect(written).toContain('file = {/Users/collegue/PDFs/Autre.pdf}');
    expect(written).not.toContain(projectDir);
  });

  // Le .bib d'une ancienne synchronisation désigne encore l'ancien dossier du projet, renommé depuis.
  it('projet renommé : la réécriture range relatif le PDF que l’ancien chemin absolu désignait', async () => {
    await openProject();
    fs.mkdirSync(path.join(projectDir, 'PDFs'));
    fs.writeFileSync(path.join(projectDir, 'PDFs', 'Garde.pdf'), '%PDF-1.4');
    fs.writeFileSync(projectBib(), PROJET.replace('year = {2000},', () => `year = {2000},\n  file = {${projectDir}-avant/PDFs/Garde.pdf},`));
    const source = downloaded('collegue.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 1 });

    expect(fs.readFileSync(projectBib(), 'utf8')).toContain('file = {PDFs/Garde.pdf}');
  });

  // La copie d'un projet écrit avant le correctif, l'original encore en place : le .bib et les
  // métadonnées désignent le PDF de l'original, qui existe. Celui de la copie est le téléchargement
  // de la référence dans ce projet : la réécriture le range relatif, sans le chemin de l'original.
  it('copie d’un projet ancien, l’original en place : la réécriture range relatif le PDF de la copie', async () => {
    await openProject();
    const original = tempDir('cliodeck-projet-original-');
    const originalPdf = path.join(original, 'PDFs', 'Garde.pdf');
    for (const dir of [original, projectDir]) {
      fs.mkdirSync(path.join(dir, 'PDFs'));
      fs.writeFileSync(path.join(dir, 'PDFs', 'Garde.pdf'), '%PDF-1.4 Garde');
    }
    fs.writeFileSync(projectBib(), PROJET.replace('year = {2000},', () => `year = {2000},\n  file = {${originalPdf}},`));
    fs.writeFileSync(
      path.join(projectDir, '.cliodeck', 'bibliography-metadata.json'),
      JSON.stringify({
        version: 2,
        lastUpdated: '2026-01-01T00:00:00.000Z',
        citations: {
          GARD2000: {
            id: 'Garde_2000',
            zoteroKey: 'GARD2000',
            zoteroAttachments: [{ key: 'ATT1', filename: 'Garde.pdf', contentType: 'application/pdf', downloaded: true, localPath: originalPdf }],
          },
        },
      })
    );
    const source = downloaded('collegue.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 1 });

    const written = fs.readFileSync(projectBib(), 'utf8');
    expect(written).toContain('file = {PDFs/Garde.pdf}');
    expect(written).not.toContain(original);
  });

  it('des métadonnées illisibles n’arrêtent pas la fusion, qui ne les réécrit pas', async () => {
    await openProject();
    const metadataFile = path.join(projectDir, '.cliodeck', 'bibliography-metadata.json');
    fs.writeFileSync(metadataFile, '{ "citations": ');
    const source = downloaded('collegue.bib', COLLEGUE);

    expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 1 });

    expect(idsOf(projectBib())).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015']);
    expect(fs.readFileSync(metadataFile, 'utf8')).toBe('{ "citations": ');
  });

  /**
   * Le .bib d'un autre projet ClioDeck : le parseur résout son `PDFs/doc.pdf` dans l'autre projet,
   * où il existe. `PDFs/` du projet a un homonyme, le PDF d'une autre référence : la collision est
   * la règle sur un corpus de presse (#131). La référence importée recevait ce PDF-là.
   */
  describe('le .bib d’un autre projet, dont PDFs/ a un homonyme dans le projet', () => {
    let otherPdf = '';

    beforeEach(async () => {
      await openProject({ bib: entry('Garde_2000', 'Le temps des archives', '\n  file = {PDFs/doc.pdf},') });
      fs.mkdirSync(path.join(projectDir, 'PDFs'));
      fs.writeFileSync(path.join(projectDir, 'PDFs', 'doc.pdf'), '%PDF-1.4 Garde (projet)');
      const other = tempDir('cliodeck-autre-projet-');
      fs.mkdirSync(path.join(other, 'PDFs'));
      otherPdf = path.join(other, 'PDFs', 'doc.pdf');
      fs.writeFileSync(otherPdf, '%PDF-1.4 Autre (autre projet)');
      const source = path.join(other, 'bibliography.bib');
      fs.writeFileSync(source, entry('Autre_2015', 'Un autre livre', '\n  file = {PDFs/doc.pdf},'));
      expect(await importBib(source, 'merge')).toMatchObject({ success: true, newCitations: 1 });
    });

    it('au chargement, la référence importée garde son PDF', async () => {
      const loaded = (await h.handlers.get('bibliography:load-with-metadata')!({}, { filePath: projectBib(), projectPath: projectDir })) as {
        success: boolean;
        citations: Array<{ id: string; file?: string }>;
      };

      expect(loaded.success).toBe(true);
      expect(loaded.citations.find((c) => c.id === 'Autre_2015')?.file).toBe(otherPdf);
      expect(loaded.citations.find((c) => c.id === 'Garde_2000')?.file).toBe(path.join(projectDir, 'PDFs', 'doc.pdf'));
    });

    it('la fusion suivante réécrit son lien tel quel, pas vers l’homonyme du projet', async () => {
      const next = downloaded('seminaire.bib', entry('Tiers_2020', 'Un troisième livre'));

      expect(await importBib(next, 'merge')).toMatchObject({ success: true, newCitations: 1 });

      const written = fs.readFileSync(projectBib(), 'utf8');
      expect(written).toContain(`file = {${otherPdf}}`);
      expect(written.match(/file = \{PDFs\/doc\.pdf\}/g)).toHaveLength(1);
    });
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

/**
 * Ce que le `.bib` du projet porte hors de ses entrées (H2) : en-tête, `@comment` (les groupes de
 * BibDesk et de JabRef), `@preamble`, texte libre. « Fusionner » réécrit le fichier depuis ses
 * citations, et l'exporteur n'écrit que des entrées : tout le reste disparaissait. « Remplacer »
 * met le fichier importé tel quel, avec ses blocs à lui, pas ceux du fichier qu'il remplace.
 */
describe('ce que le .bib du projet porte hors de ses entrées', () => {
  const FIXTURES = fileURLToPath(new URL('../../../../../backend/core/bibliography/__tests__/fixtures/', import.meta.url));
  const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.bib`), 'utf8');
  const count = (text: string, part: string) => text.split(part).length - 1;

  it('« Fusionner » deux fois : l’en-tête BibDesk reste en tête, ses groupes en fin, à l’octet, une seule fois', async () => {
    const original = fixture('blocs-bibdesk');
    await openProject({ bib: original });
    const head = original.slice(0, original.indexOf('@book{Garde2000,')).trimEnd();
    const groups = original.slice(original.indexOf('@comment{BibDesk Static Groups{')).trimEnd();

    expect(await importBib(downloaded('collegue.bib', entry('Autre_2015', 'Un autre livre')), 'merge')).toMatchObject({
      success: true,
      newCitations: 1,
    });
    expect(fs.readFileSync(bibBackupPath(projectDir), 'utf8')).toBe(original);
    expect(await importBib(downloaded('neuf.bib', entry('Neuf_2020', 'Un livre neuf')), 'merge')).toMatchObject({
      success: true,
      newCitations: 1,
    });

    const written = fs.readFileSync(projectBib(), 'utf8');
    expect(written.startsWith(head)).toBe(true);
    expect(written.endsWith(`${groups}\n`)).toBe(true);
    expect([count(written, head), count(written, groups)]).toEqual([1, 1]);
    const citations = new BibTeXParser().parse(written);
    expect(citations.map((c) => c.id)).toEqual(['Garde2000', 'Leduc1990', 'Autre_2015', 'Neuf_2020']);
    expect(auditParsedBib(written, citations).unreadKeys).toEqual([]);
  });

  it('« Fusionner » : le préambule reste en tête, le texte libre d’entre deux entrées passe en fin, dans l’ordre', async () => {
    const original = fixture('blocs-preambule');
    await openProject({ bib: original });
    const head = original.slice(0, original.indexOf('@book{Garde2000,')).trimEnd();
    const between = original.slice(original.indexOf('% --- Sources imprimées ---'), original.indexOf('@article{Leduc1990,')).trimEnd();
    const tail = original.slice(original.indexOf('@comment(à revoir')).trimEnd();

    expect(await importBib(downloaded('collegue.bib', entry('Autre_2015', 'Un autre livre')), 'merge')).toMatchObject({
      success: true,
      newCitations: 1,
    });

    const written = fs.readFileSync(projectBib(), 'utf8');
    expect(written.startsWith(head)).toBe(true);
    expect(written.indexOf(between)).toBeGreaterThan(written.indexOf('@book{Autre_2015,'));
    expect(written.endsWith(`${between}\n\n${tail}\n`)).toBe(true);
    expect([count(written, head), count(written, between), count(written, tail)]).toEqual([1, 1, 1]);
    expect(idsOf(projectBib())).toEqual(['Garde2000', 'Leduc1990', 'Autre_2015']);
  });

  // Le parseur colle au type de l'entrée qui suit ce qui va d'une arobase hors des entrées à son
  // accolade, et la réécriture l'écrit avec l'entrée : repris aussi en fin de fichier, ce texte s'y
  // ajoutait à chaque fusion qui écrivait.
  it('« Fusionner » deux fois, une arobase dans un commentaire % entre deux entrées : rien ne s’ajoute en fin de fichier', async () => {
    const jabref = '@Comment{jabref-meta: databaseType:biblatex;}';
    const original = `${entry('Garde_2000', 'Le temps des archives')}\n% voir aussi @Garde_2000 pour le contexte\n${entry('Main_2010', 'Une note à la main')}\n${jabref}\n`;
    await openProject({ bib: original });

    expect(await importBib(downloaded('collegue.bib', entry('Autre_2015', 'Un autre livre')), 'merge')).toMatchObject({ newCitations: 1 });
    const first = fs.readFileSync(projectBib(), 'utf8');
    expect(await importBib(downloaded('neuf.bib', entry('Neuf_2020', 'Un livre neuf')), 'merge')).toMatchObject({ newCitations: 1 });

    const written = fs.readFileSync(projectBib(), 'utf8');
    expect([count(written, '@Garde_2000 pour le contexte'), count(written, '% voir aussi'), count(written, jabref)]).toEqual([1, 1, 1]);
    expect(written.slice(written.indexOf('% voir aussi'))).toBe(first.slice(first.indexOf('% voir aussi')));
    const citations = new BibTeXParser().parse(written);
    expect(citations.map((c) => c.id)).toEqual(['Garde_2000', 'Main_2010', 'Autre_2015', 'Neuf_2020']);
    expect(auditParsedBib(written, citations).unreadKeys).toEqual([]);
  });

  it('« Remplacer » : le fichier écrit est le fichier importé, sans les blocs de l’ancien', async () => {
    const original = fixture('blocs-bibdesk');
    await openProject({ bib: original });
    const imported = `@comment{jabref-meta: databaseType:bibtex;}\n\n${COLLEGUE}`;

    expect(await importBib(downloaded('bibliography.bib', imported), 'replace')).toMatchObject({ success: true, total: 2 });

    expect(fs.readFileSync(projectBib(), 'utf8')).toBe(imported);
    expect(fs.readFileSync(bibBackupPath(projectDir), 'utf8')).toBe(original);
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
