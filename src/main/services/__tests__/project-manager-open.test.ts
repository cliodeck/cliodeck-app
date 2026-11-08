/**
 * « Ouvrir un projet » refuse ce qui n'est pas un manifeste, sans laisser de trace (S11-1-18).
 *
 * Le dialogue filtre sur l'extension : n'importe quel `.json` arrivait à `loadProject`, recevait
 * `lastOpenedAt`, et son dossier recevait un `.cliodeck`, un `brain.db`, une place dans les récents.
 * Le risque en miroir est le faux refus : il fermerait à l'auteur son propre projet. D'où la revue
 * de toutes les formes de manifeste que l'histoire du dépôt a écrites.
 *
 * Vrai disque, vraie migration : c'est elle qui poserait `.cliodeck` dans le dossier. Seul
 * `configManager` est remplacé. Le `brain.db` des services se juge dans le parcours e2e.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

const { addRecentProject } = vi.hoisted(() => ({ addRecentProject: vi.fn() }));

vi.mock('../config-manager.js', () => ({
  configManager: { addRecentProject, removeRecentProject: vi.fn(), getRecentProjects: vi.fn(() => []) },
}));

vi.mock('../../../../backend/core/workspace/migrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../backend/core/workspace/migrator.js')>();
  return { ...actual, migrateWorkspaceToFlat: vi.fn(actual.migrateWorkspaceToFlat) };
});

import { ProjectManager } from '../project-manager.js';
import { recordProjectCollection, zoteroService } from '../zotero-service.js';
import { migrateWorkspaceToFlat } from '../../../../backend/core/workspace/migrator.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const CSL_JSON = `${JSON.stringify(
  [
    { id: 'braudel1949', type: 'book', title: 'La Méditerranée' },
    { id: 'bloch1924', type: 'book', title: 'Les rois thaumaturges' },
  ],
  null,
  2
)}\n`;
const PACKAGE_JSON = `${JSON.stringify({ name: 'mon-outil', version: '1.0.0', dependencies: {} }, null, 2)}\n`;
/** Un fichier de réglages d'un autre outil, qui se trouve porter un `type` connu de ClioDeck. */
const OTHER_SETTINGS = '{"type":"article","theme":"dark"}\n';
const LATIN1 = Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xc9, 0x22, 0x7d]);

let workDir: string;
let projectDir: string;
let manager: ProjectManager;

interface LoadResponse {
  success: boolean;
  code?: string;
  fileName?: string;
  error?: string;
  project?: Record<string, unknown>;
}

/** Tout le dossier : chaque entrée, sa taille, sa date, ses octets. Une écriture de passage change la date du dossier. */
function folderState(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.join(prefix, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      out[`${rel}/`] = String(stat.mtimeMs);
      Object.assign(out, folderState(full, rel));
    } else {
      out[rel] = `${stat.size}|${stat.mtimeMs}|${readFileSync(full).toString('base64')}`;
    }
  }
  out['.'] = String(statSync(dir).mtimeMs);
  return out;
}

function writeHere(name: string, content: string | Buffer): string {
  const file = path.join(projectDir, name);
  writeFileSync(file, content);
  return file;
}

const load = (file: string) => manager.loadProject(file) as Promise<LoadResponse>;
const metadataOf = (file: string) => manager.getProjectMetadata(file) as Promise<LoadResponse>;

/** Ouvre un projet A : ce qu'un refus doit laisser en place. */
async function openProjectA(): Promise<string> {
  const dirA = path.join(workDir, 'A');
  mkdirSync(dirA);
  const fileA = path.join(dirA, 'project.json');
  writeFileSync(fileA, JSON.stringify({ name: 'A', type: 'article' }));
  expect((await load(fileA)).success).toBe(true);
  addRecentProject.mockClear();
  vi.mocked(migrateWorkspaceToFlat).mockClear();
  return dirA;
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-ouvrir-'));
  projectDir = path.join(workDir, 'Dossier');
  mkdirSync(projectDir);
  manager = new ProjectManager();
  addRecentProject.mockClear();
  vi.mocked(migrateWorkspaceToFlat).mockClear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('le défaut d’origine : un CSL-JSON n’est plus réécrit', () => {
  it('tableau choisi : refus, intact à l’octet, pas de .cliodeck, pas dans les récents', async () => {
    const file = writeHere('references.json', CSL_JSON);
    const before = folderState(projectDir);

    const result = await load(file);

    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(CSL_JSON);
    expect(folderState(projectDir)).toEqual(before);
    expect(existsSync(path.join(projectDir, '.cliodeck'))).toBe(false);
    expect(addRecentProject).not.toHaveBeenCalled();
  });
});

/** Le chemin ne vaut pas un manifeste : ni lecture ni contenu n'y changent rien. */
const WRONG_NAME: Array<[string, string, string | Buffer]> = [
  ['un CSL-JSON', 'references.json', CSL_JSON],
  ['un package.json, qui porte name', 'package.json', PACKAGE_JSON],
  ['les réglages d’un autre outil, qui portent un type connu', 'settings.json', OTHER_SETTINGS],
  ['un .json vide', 'vide.json', ''],
  ['un JSON invalide', 'casse.json', '{ "name": '],
  ['du Latin-1', 'latin1.json', LATIN1],
  ['une copie de conflit iCloud du manifeste', 'project 2.json', JSON.stringify({ name: 'Thèse', type: 'article' })],
  ['ce que laisse passer « Tous les fichiers »', 'document.md', '# Titre\n'],
];

describe.each(WRONG_NAME)('%s', (_label, name, content) => {
  it('loadProject : not_a_project, le fichier nommé, le dossier inchangé, A toujours ouvert', async () => {
    const dirA = await openProjectA();
    const file = writeHere(name, content);
    const before = folderState(projectDir);

    const result = await load(file);

    expect(result).toMatchObject({ success: false, code: 'not_a_project', fileName: name });
    expect(result.project).toBeUndefined();
    expect(folderState(projectDir)).toEqual(before);
    expect(addRecentProject).not.toHaveBeenCalled();
    expect(migrateWorkspaceToFlat).not.toHaveBeenCalled();
    expect(manager.getCurrentProjectPath()).toBe(dirA);
    expect(manager.getCurrentProject()?.name).toBe('A');
  });

  it('getProjectMetadata : le même refus, et rien de créé', async () => {
    const file = writeHere(name, content);
    const before = folderState(projectDir);

    const result = await metadataOf(file);

    expect(result).toMatchObject({ success: false, code: 'not_a_project', fileName: name });
    expect(folderState(projectDir)).toEqual(before);
  });
});

/** Il porte le bon nom et ne décrit pas un projet : il peut se réparer, il ne sort pas des récents. */
const WRONG_CONTENT: Array<[string, string]> = [
  ['un objet vide', '{}'],
  ['les réglages d’un autre outil', '{"theme":"dark"}'],
  ['name n’est pas un texte', '{"name":42}'],
  ['type inconnu, sans name', '{"type":"these"}'],
  ['name et type nuls', '{"name":null,"type":null}'],
  ['un tableau', CSL_JSON],
  ['null', 'null'],
  ['un nombre', '42'],
];

describe.each(WRONG_CONTENT)('project.json : %s', (_label, content) => {
  it('manifest_invalid aux deux portes, rien d’écrit, rien de créé', async () => {
    const dirA = await openProjectA();
    const file = writeHere('project.json', content);
    const before = folderState(projectDir);

    expect(await metadataOf(file)).toMatchObject({
      success: false,
      code: 'manifest_invalid',
      fileName: 'project.json',
    });
    expect(await load(file)).toMatchObject({ success: false, code: 'manifest_invalid', fileName: 'project.json' });

    expect(folderState(projectDir)).toEqual(before);
    expect(addRecentProject).not.toHaveBeenCalled();
    expect(migrateWorkspaceToFlat).not.toHaveBeenCalled();
    expect(manager.getCurrentProjectPath()).toBe(dirA);
  });
});

describe('le faux refus : toutes les formes de manifeste que ClioDeck a écrites s’ouvrent', () => {
  it.each(['article', 'book', 'presentation'])('un projet %s créé aujourd’hui, relu par une session neuve', async (type) => {
    const created = await manager.createProject({ name: 'Neuf', type, path: projectDir });
    expect(created.success).toBe(true);
    const file = path.join(projectDir, 'Neuf', 'project.json');

    const fresh = new ProjectManager();
    expect(await fresh.getProjectMetadata(file)).toMatchObject({ success: true });
    expect(await fresh.loadProject(file)).toMatchObject({ success: true, project: { name: 'Neuf', type } });
  });

  const CHAPTER_V0 = { id: 'c1', title: 'Un', order: 0, filePath: 'chapters/un.md' };

  it.each<[string, Record<string, unknown>]>([
    ['sans type, avec name', { name: 'Ancienne thèse' }],
    ['sans name, type article', { type: 'article' }],
    ['sans name, type book', { type: 'book' }],
    ['sans name, type presentation', { type: 'presentation' }],
    ['name, et le type « notes » des premières versions', { name: 'Carnet', type: 'notes' }],
    ['name, et un type que cette version ne connaît pas', { name: 'De demain', type: 'atlas' }],
    ['name vide, sans type', { name: '' }],
    [
      'le premier format : chemin stocké, sans id',
      { name: 'Article', path: '/ancien/emplacement', type: 'article', createdAt: '', updatedAt: '' },
    ],
    [
      'le réglage d’éditeur retiré en juillet 2026',
      {
        id: 'x',
        name: 'Article',
        type: 'article',
        createdAt: '2026-03-11T00:00:00.000Z',
        updatedAt: '2026-03-11T00:00:00.000Z',
        lastOpenedAt: '2026-03-11T00:00:00.000Z',
        defaultEditor: 'wysiwyg',
      },
    ],
    [
      'des chemins absolus d’avant leur migration',
      {
        name: 'Article',
        type: 'article',
        bibliography: '/ailleurs/b.bib',
        bibliographySource: { type: 'file', filePath: '/ailleurs/b.bib' },
        cslPath: '/ailleurs/s.csl',
      },
    ],
    [
      'un livre sans chapters ni réglages complets',
      { name: 'Livre', type: 'book', createdAt: '', updatedAt: '', book: { noteStyle: 'endnote-book' } },
    ],
    ['un livre aux chapitres du premier format, sans kind', { name: 'Livre', type: 'book', chapters: [CHAPTER_V0] }],
    ['un bloc zotero', { name: 'Test', type: 'article', zotero: { collectionKey: 'AI' } }],
    ['des champs de demain', { name: 'Test', type: 'book', champ_de_demain: { garde: 'moi' } }],
    // Limite assumée de la fiche : refuser un manifeste sans `type` fermerait un projet ancien.
    ['le project.json d’un autre outil, s’il porte name', { name: 'autre-outil', targets: { build: {} } }],
  ])('%s', async (_label, manifest) => {
    const file = writeHere('project.json', JSON.stringify(manifest));
    const before = folderState(projectDir);

    const metadata = await metadataOf(file);
    expect(metadata.success).toBe(true);
    expect(metadata.code).toBeUndefined();
    // Lire pour les récents ne touche à rien.
    expect(folderState(projectDir)).toEqual(before);

    const result = await load(file);
    expect(result.success).toBe(true);
    expect(manager.getCurrentProjectPath()).toBe(projectDir);
    expect(addRecentProject).toHaveBeenCalledWith(file);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(onDisk.lastOpenedAt).toEqual(expect.any(String));
    expect(onDisk.name).toEqual(manifest.name);
    expect(onDisk.type).toEqual(manifest.type);
  });

  it.skipIf(!symlinkAvailable)('un lien nommé project.json s’ouvre, et reste un lien', async () => {
    const elsewhere = path.join(workDir, 'Ailleurs');
    mkdirSync(elsewhere);
    const target = path.join(elsewhere, 'manifeste-partage.json');
    writeFileSync(target, JSON.stringify({ name: 'Partagé', type: 'article' }));
    const file = path.join(projectDir, 'project.json');
    symlinkSync(target, file);

    expect(await metadataOf(file)).toMatchObject({ success: true });
    expect(await load(file)).toMatchObject({ success: true, project: { name: 'Partagé' } });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8')).lastOpenedAt).toEqual(expect.any(String));
  });

  it.skipIf(!symlinkAvailable)('un lien nommé autrement refusé, même vers un vrai manifeste', async () => {
    const real = writeHere('project.json', JSON.stringify({ name: 'Vrai', type: 'article' }));
    const link = path.join(projectDir, 'lien.json');
    symlinkSync(real, link);
    const before = folderState(projectDir);

    expect(await load(link)).toMatchObject({ success: false, code: 'not_a_project', fileName: 'lien.json' });
    expect(folderState(projectDir)).toEqual(before);
  });
});

describe('la casse du nom : le projet s’ouvre seulement s’il pourra se relire', () => {
  const probe = (): boolean => {
    const dir = path.join(os.tmpdir(), `cliodeck-casse-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'sonde'), '');
    const insensitive = existsSync(path.join(dir, 'SONDE'));
    rmSync(path.join(dir, 'sonde'));
    rmSync(dir, { recursive: true });
    return insensitive;
  };
  /** macOS et Windows : un seul fichier, sous les deux noms. Sous Linux : deux fichiers possibles. */
  const caseInsensitive = probe();
  const MANIFEST = JSON.stringify({ name: 'Casse', type: 'article' });

  it.runIf(caseInsensitive)('disque sans casse : Project.json s’ouvre, et tout passe ensuite par project.json', async () => {
    const chosen = writeHere('Project.json', MANIFEST);

    expect(await metadataOf(chosen)).toMatchObject({ success: true });
    const result = await load(chosen);

    expect(result).toMatchObject({ success: true, project: { name: 'Casse', path: projectDir } });
    expect(addRecentProject).toHaveBeenCalledTimes(1);
    expect(path.basename(addRecentProject.mock.calls[0][0] as string)).toBe('project.json');
    // Relu au nom qu'emploie tout le reste du code, et il reste un seul manifeste dans le dossier.
    const reread = await manager.saveProject({ path: path.join(projectDir, 'project.json'), content: '' });
    expect(reread.success).toBe(true);
    const manifests = readdirSync(projectDir).filter((name) => name.toLowerCase() === 'project.json');
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8')).lastOpenedAt).toEqual(
      expect.any(String)
    );
  });

  it.runIf(!caseInsensitive)('disque à casse : Project.json seul se refuse, rien ne pourrait le relire', async () => {
    const chosen = writeHere('Project.json', MANIFEST);
    const before = folderState(projectDir);

    expect(await metadataOf(chosen)).toMatchObject({ success: false, code: 'manifest_invalid' });
    expect(await load(chosen)).toMatchObject({ success: false, code: 'manifest_invalid', fileName: 'Project.json' });
    expect(folderState(projectDir)).toEqual(before);
    expect(addRecentProject).not.toHaveBeenCalled();
  });

  it.runIf(!caseInsensitive)('disque à casse : Project.json à côté d’un vrai project.json, autre fichier, refusé', async () => {
    const chosen = writeHere('Project.json', JSON.stringify({ name: 'Autre', type: 'article' }));
    const real = writeHere('project.json', MANIFEST);

    expect(await load(chosen)).toMatchObject({ success: false, code: 'manifest_invalid' });
    expect(await load(real)).toMatchObject({ success: true, project: { name: 'Casse' } });
  });

  it('Project.json absent, dossier présent : une absence, pas un refus', async () => {
    const result = await metadataOf(path.join(projectDir, 'Project.json'));
    expect(result).toMatchObject({ success: false, code: 'project_file_missing' });
  });

  it('Project.json sur un disque débranché : caché, jamais not_a_project', async () => {
    const result = await metadataOf(path.join(workDir, 'NulPart', 'Project.json'));
    expect(result).toMatchObject({ success: false, code: 'project_unavailable' });
  });
});

describe('un fichier qui ne peut pas être un projet n’a pas besoin du disque pour le dire', () => {
  it('references.json sur un disque débranché : not_a_project, la ligne des récents peut partir', async () => {
    const result = await metadataOf(path.join(workDir, 'NulPart', 'references.json'));
    expect(result).toMatchObject({ success: false, code: 'not_a_project', fileName: 'references.json' });
  });

  it('project.json sur un disque débranché : caché, jamais retiré', async () => {
    const result = await metadataOf(path.join(workDir, 'NulPart', 'project.json'));
    expect(result).toMatchObject({ success: false, code: 'project_unavailable' });
  });

  it('un project.json abîmé garde son code aux deux portes, et l’erreur de lecture son texte', async () => {
    const file = writeHere('project.json', '{ "name": "Thèse", ');
    expect(await metadataOf(file)).toMatchObject({ success: false, code: 'manifest_unreadable' });
    const result = await load(file);
    expect(result).toMatchObject({ success: false, code: 'manifest_unreadable', fileName: 'project.json' });
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe('manifest_unreadable');
  });
});

describe('un project.json avec BOM, posé par un éditeur Windows : un vrai projet, et le BOM reste', () => {
  const BOM = '﻿';
  const hasOneBom = (file: string): boolean => {
    const bytes = readFileSync(file);
    const marker = Buffer.from([0xef, 0xbb, 0xbf]);
    return bytes.subarray(0, 3).equals(marker) && !bytes.subarray(3, 6).equals(marker);
  };
  const withoutBom = (file: string) => JSON.parse(readFileSync(file, 'utf8').slice(1)) as Record<string, unknown>;

  it('lire ne réécrit rien ; ouvrir réussit, deux fois de suite, avec un seul BOM', async () => {
    const file = writeHere('project.json', `${BOM}${JSON.stringify({ name: 'Windows', type: 'article' })}`);
    const before = folderState(projectDir);

    expect(await metadataOf(file)).toMatchObject({ success: true, project: { name: 'Windows' } });
    expect(folderState(projectDir)).toEqual(before);

    expect(await load(file)).toMatchObject({ success: true, project: { name: 'Windows', type: 'article' } });
    expect(addRecentProject).toHaveBeenCalledWith(file);
    expect(hasOneBom(file)).toBe(true);
    expect(withoutBom(file).lastOpenedAt).toEqual(expect.any(String));

    expect(await new ProjectManager().loadProject(file)).toMatchObject({ success: true });
    expect(hasOneBom(file)).toBe(true);
  });

  it('un manifeste sans BOM n’en reçoit pas', async () => {
    const file = writeHere('project.json', JSON.stringify({ name: 'Sans', type: 'article' }));
    await load(file);
    expect(readFileSync(file).subarray(0, 1).toString()).toBe('{');
  });

  it('les réglages se lisent, et leur écriture garde le BOM', async () => {
    const file = writeHere('project.json', `${BOM}${JSON.stringify({ name: 'Windows', type: 'article' })}`);

    expect(await manager.getConfig(file)).toMatchObject({ name: 'Windows' });
    expect(await manager.updateConfig(file, { cslPath: 'style.csl' })).toMatchObject({ success: true });

    expect(hasOneBom(file)).toBe(true);
    expect(withoutBom(file).cslPath).toBe('style.csl');
  });

  it('un livre garde ses chapitres : les lire ne les perd pas, et les réordonner garde le BOM', async () => {
    mkdirSync(path.join(projectDir, 'chapters'));
    writeFileSync(path.join(projectDir, 'chapters', 'un.md'), '# Un\n');
    const chapter = { id: 'c1', title: 'Un', order: 0, filePath: 'chapters/un.md', kind: 'chapter' as const };
    const file = writeHere('project.json', `${BOM}${JSON.stringify({ name: 'Livre', type: 'book', chapters: [chapter] })}`);

    expect(await load(file)).toMatchObject({ success: true });
    const chapters = await manager.getChapters(file);
    expect(chapters).toMatchObject({ success: true, chapters: [{ id: 'c1' }] });

    expect(await manager.saveChapters({ projectPath: file, chapters: [{ ...chapter, title: 'Premier' }] })).toMatchObject({
      success: true,
    });
    expect(hasOneBom(file)).toBe(true);
    expect((withoutBom(file).chapters as Array<{ title: string }>)[0].title).toBe('Premier');
  });

  it('la synchronisation Zotero lit le manifeste, et sa collection s’y écrit sans perdre le BOM', async () => {
    const file = writeHere('project.json', `${BOM}${JSON.stringify({ name: 'Windows', type: 'article' })}`);
    const source = vi
      .spyOn(zoteroService as unknown as { createDataSource: () => unknown }, 'createDataSource')
      .mockImplementation(() => {
        throw new Error('la source est atteinte');
      });

    const result = await zoteroService.synchronizeProject({ projectPath: projectDir, collectionKey: 'C' } as never);
    source.mockRestore();

    expect(result).toMatchObject({ success: false, error: 'la source est atteinte' });

    await recordProjectCollection(file, 'bibliography.bib', 'C');
    expect(hasOneBom(file)).toBe(true);
    expect(withoutBom(file).zotero).toEqual({ collectionKey: 'C' });
  });

  it.each<[string, string, string]>([
    ['un BOM seul', BOM, 'manifest_unreadable'],
    ['un BOM et un JSON invalide', `${BOM}{ "name": `, 'manifest_unreadable'],
    ['un BOM et un objet vide', `${BOM}{}`, 'manifest_invalid'],
    ['un BOM et un tableau', `${BOM}[]`, 'manifest_invalid'],
  ])('%s : le BOM n’ouvre pas ce qui n’est pas un projet, et rien ne s’écrit', async (_label, content, code) => {
    const file = writeHere('project.json', content);
    const before = folderState(projectDir);

    expect(await metadataOf(file)).toMatchObject({ success: false, code });
    expect(await load(file)).toMatchObject({ success: false, code });

    expect(folderState(projectDir)).toEqual(before);
    expect(addRecentProject).not.toHaveBeenCalled();
  });

  it('un autre fichier avec BOM reste refusé sur son nom', async () => {
    const file = writeHere('package.json', `${BOM}${PACKAGE_JSON}`);
    expect(await metadataOf(file)).toMatchObject({ success: false, code: 'not_a_project' });
  });
});

describe('créer dans un dossier où un autre outil a son project.json (L02-2)', () => {
  it('project_exists, et son fichier intact', async () => {
    const other = path.join(projectDir, 'Outil');
    mkdirSync(other);
    const theirs = path.join(other, 'project.json');
    writeFileSync(theirs, '{"targets":{"build":{}}}');
    const before = folderState(other);

    const result = await manager.createProject({ name: 'Outil', type: 'article', path: projectDir });

    expect(result).toEqual({ success: false, error: 'project_exists' });
    expect(folderState(other)).toEqual(before);
    expect(addRecentProject).not.toHaveBeenCalled();
  });
});
