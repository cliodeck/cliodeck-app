/**
 * `project.json` : une seule porte d'écriture, un seul format, et ce qui ne se lit pas ne se
 * réécrit pas.
 *
 * Chaque écrivain lisait le fichier, attendait, puis écrivait par `writeFile` : deux écritures
 * proches perdaient les chapitres ou les réglages, et le `bibliography` résolu en absolu entrait
 * sur le disque à chaque ouverture. Et pour les récents, tout échec valait « ce projet n'existe
 * plus » : un disque débranché suffisait à l'effacer de la liste (S11-2-8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({
  /** Chemin dont le `stat` tombe sur l'erreur donnée : OneDrive sans données locales. */
  statFailure: null as { file: string; code: string } | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const mocked = {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (h.statFailure && args[0] === h.statFailure.file) {
        throw Object.assign(new Error(`${h.statFailure.code}: ${h.statFailure.file}`), {
          code: h.statFailure.code,
        });
      }
      return actual.stat(...args);
    },
  };
  return { ...mocked, default: mocked };
});

vi.mock('../config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: vi.fn(() => []),
  },
}));

vi.mock('../../../../backend/core/workspace/migrator.js', () => ({
  migrateWorkspaceToFlat: vi.fn(async () => ({ kind: 'flat', copied: [], skipped: [], warnings: [] })),
}));

import { ProjectManager } from '../project-manager.js';
import { recordProjectCollection } from '../zotero-service.js';
import { DEFAULT_BOOK_SETTINGS } from '../../../../backend/types/book.js';
import { migrateWorkspaceToFlat } from '../../../../backend/core/workspace/migrator.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const IS_ROOT = process.getuid?.() === 0;

let workDir: string;
let projectDir: string;
let projectFile: string;
let manager: ProjectManager;

const onDisk = () => JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, unknown>;

const chapter = (id: string, order: number) => ({
  id,
  title: id,
  filePath: `chapters/${id}.md`,
  order,
  kind: 'chapter' as const,
});

/** Tel qu'une ouverture l'a laissé : champs inconnus, chemins relatifs, ordre des clés. */
function realisticProject(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Thèse',
    type: 'book',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastOpenedAt: '2026-01-02T00:00:00.000Z',
    bibliographySource: { type: 'zotero', filePath: 'bibliography.bib', zoteroCollection: 'ABC' },
    zotero: { collectionKey: 'ABC', libraryID: 3 },
    cslPath: 'style.csl',
    chapters: [chapter('un', 0), chapter('deux', 1)],
    book: { ...DEFAULT_BOOK_SETTINGS },
    champ_de_demain: { garde: 'moi' },
    ...extra,
  };
}

function writeProject(content: Record<string, unknown> | string): void {
  writeFileSync(projectFile, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-atomique-'));
  projectDir = path.join(workDir, 'Thèse');
  mkdirSync(path.join(projectDir, 'chapters'), { recursive: true });
  projectFile = path.join(projectDir, 'project.json');
  writeFileSync(path.join(projectDir, 'bibliography.bib'), '');
  writeFileSync(path.join(projectDir, 'style.csl'), '<style/>');
  h.statFailure = null;
  manager = new ProjectManager();
  vi.mocked(migrateWorkspaceToFlat).mockClear();
});

afterEach(async () => {
  h.statFailure = null;
  await rm(workDir, { recursive: true, force: true });
});

describe('écritures concurrentes : aucune ne perd celle d’à côté', () => {
  it('saveBookSettings et saveChapters, 20 fois : ni chapitres ni réglages perdus', async () => {
    writeProject(realisticProject());
    const chapters = [chapter('deux', 0), chapter('un', 1)];

    for (let round = 0; round < 20; round += 1) {
      const numberChapters = round % 2 === 0;
      const results = await Promise.all([
        manager.saveChapters({ projectPath: projectFile, chapters }),
        manager.saveBookSettings({ projectPath: projectFile, settings: { numberChapters } }),
      ]);
      expect(results.every((r) => r.success)).toBe(true);

      const disk = onDisk();
      expect((disk.chapters as Array<{ id: string }>).map((c) => c.id)).toEqual(['deux', 'un']);
      expect((disk.book as { numberChapters: boolean }).numberChapters).toBe(numberChapters);
      expect(disk.champ_de_demain).toEqual({ garde: 'moi' });
    }
  });

  it('tous les écrivains ensemble : chacun garde son champ', async () => {
    writeProject(realisticProject({ chapters: [] }));

    const results = await Promise.all([
      manager.saveChapters({ projectPath: projectFile, chapters: [chapter('un', 0)] }),
      manager.saveBookSettings({ projectPath: projectFile, settings: { numberSections: true } }),
      manager.setBibliographySource({ projectPath: projectFile, type: 'file', filePath: 'autre.bib' }),
      manager.setCSLPath({ projectPath: projectFile, cslPath: path.join(projectDir, 'style.csl') }),
      manager.updateConfig(projectFile, { zotero: { collectionKey: 'XYZ' } } as never),
      manager.saveProject({ path: projectFile, content: '' }),
    ]);
    expect(results.every((r) => r.success)).toBe(true);

    const disk = onDisk();
    expect((disk.chapters as Array<{ id: string }>).map((c) => c.id)).toEqual(['un']);
    expect((disk.book as { numberSections: boolean }).numberSections).toBe(true);
    expect(disk.bibliographySource).toMatchObject({ type: 'file', filePath: 'autre.bib' });
    expect(disk.cslPath).toBe('style.csl');
    expect(disk.zotero).toEqual({ collectionKey: 'XYZ', libraryID: 3 });
  });

  it('createChapter en rafale, avec des réglages : tous les chapitres, deux fichiers distincts par titre', async () => {
    writeProject(realisticProject({ chapters: [] }));

    const results = await Promise.all([
      manager.createChapter({ projectPath: projectFile, title: 'Annexe' }),
      manager.saveBookSettings({ projectPath: projectFile, settings: { numberChapters: true } }),
      manager.createChapter({ projectPath: projectFile, title: 'Annexe' }),
      manager.createChapter({ projectPath: projectFile, title: 'Annexe' }),
    ]);
    expect(results.every((r) => r.success)).toBe(true);

    const disk = onDisk();
    const chapters = disk.chapters as Array<{ filePath: string; order: number }>;
    expect(chapters).toHaveLength(3);
    expect(new Set(chapters.map((c) => c.filePath)).size).toBe(3);
    expect(chapters.map((c) => c.order)).toEqual([0, 1, 2]);
    for (const c of chapters) expect(existsSync(path.join(projectDir, c.filePath))).toBe(true);
    expect((disk.book as { numberChapters: boolean }).numberChapters).toBe(true);
  });

  /**
   * Limite assumée : `chapters` reste écrit en entier depuis le renderer, qui seul sait ce qu'il a
   * retiré. Le manifeste perd l'entrée, jamais le texte : le fichier reste, et se propose comme non
   * rattaché. Distinguer retrait et ignorance demande un autre échange avec le renderer.
   */
  it('createChapter puis saveChapters sur la liste d’avant : l’entrée part, le fichier reste, non rattaché', async () => {
    const before = [chapter('un', 0)];
    writeProject(realisticProject({ chapters: before }));
    writeFileSync(path.join(projectDir, 'chapters', 'un.md'), '# Un\n');

    const [created, saved] = await Promise.all([
      manager.createChapter({ projectPath: projectFile, title: 'Neuf' }),
      manager.saveChapters({ projectPath: projectFile, chapters: before }),
    ]);
    expect(created.success).toBe(true);
    expect(saved.success).toBe(true);

    expect((onDisk().chapters as Array<{ id: string }>).map((c) => c.id)).toEqual(['un']);
    const filePath = (created as { chapter: { filePath: string } }).chapter.filePath;
    expect(readFileSync(path.join(projectDir, filePath), 'utf8')).toBe('# Neuf\n\n');
    const listed = await manager.getChapters(projectFile);
    expect(listed.unattached.map((file) => file.filePath)).toContain(filePath);
  });

  it('synchronisation Zotero et chapitres, 20 fois : la collection et le plan restent', async () => {
    writeProject(realisticProject({ bibliographySource: undefined, zotero: { libraryID: 3 } }));
    const chapters = [chapter('deux', 0), chapter('un', 1)];

    for (let round = 0; round < 20; round += 1) {
      const collection = `COLL${round}`;
      await Promise.all([
        recordProjectCollection(projectFile, 'bibliography.bib', collection),
        manager.saveChapters({ projectPath: projectFile, chapters }),
      ]);

      const disk = onDisk();
      expect((disk.chapters as Array<{ id: string }>).map((c) => c.id)).toEqual(['deux', 'un']);
      expect(disk.bibliographySource).toEqual({
        type: 'zotero',
        filePath: 'bibliography.bib',
        zoteroCollection: collection,
      });
      expect(disk.zotero).toEqual({ libraryID: 3, collectionKey: collection });
    }
  });

  it('synchronisation Zotero et bibliothèque choisie, 20 fois : la collection et la bibliothèque restent', async () => {
    writeProject(realisticProject());

    for (let round = 0; round < 20; round += 1) {
      const collection = `COLL${round}`;
      await Promise.all([
        recordProjectCollection(projectFile, 'bibliography.bib', collection),
        manager.updateConfig(projectFile, { zotero: { libraryID: round } }),
      ]);

      expect(onDisk().zotero).toEqual({ collectionKey: collection, libraryID: round });
    }
  });

  it('le bloc zotero change clé par clé : ce qui n’est pas reçu reste, `undefined` efface', async () => {
    writeProject(realisticProject({ zotero: { collectionKey: 'ABC', libraryID: 3, champ_de_demain: 'garde' } }));

    await manager.updateConfig(projectFile, { zotero: { groupId: '42' } });
    expect(onDisk().zotero).toEqual({ collectionKey: 'ABC', libraryID: 3, champ_de_demain: 'garde', groupId: '42' });

    await manager.updateConfig(projectFile, { zotero: { collectionKey: undefined } });
    expect(onDisk().zotero).toEqual({ libraryID: 3, champ_de_demain: 'garde', groupId: '42' });
  });

  it('la mémoire suit ce que le disque a gardé du bloc, pas ce que le renderer a envoyé', async () => {
    writeProject(realisticProject());
    await manager.loadProject(projectFile);

    await recordProjectCollection(projectFile, 'bibliography.bib', 'SYNCHRO');
    await manager.updateConfig(projectFile, { zotero: { libraryID: 4 } });

    const current = manager.getCurrentProject() as unknown as { zotero: unknown };
    expect(current.zotero).toEqual({ collectionKey: 'SYNCHRO', libraryID: 4 });
  });

  it.each<[string, unknown]>([
    ['un tableau', ['a']],
    ['un texte', 'abc'],
  ])('zotero sur le disque est %s : remplacé par ce qui est reçu, sans y lire de clés', async (_label, stored) => {
    writeProject(realisticProject({ zotero: stored }));

    await manager.updateConfig(projectFile, { zotero: { libraryID: 4 } });

    expect(onDisk().zotero).toEqual({ libraryID: 4 });
  });

  it('une ouverture et un enregistrement de réglages : la frappe d’à côté reste', async () => {
    writeProject(realisticProject());
    for (let round = 0; round < 20; round += 1) {
      const numberSections = round % 2 === 0;
      await Promise.all([
        manager.loadProject(projectFile),
        manager.saveBookSettings({ projectPath: projectFile, settings: { numberSections } }),
      ]);
      expect((onDisk().book as { numberSections: boolean }).numberSections).toBe(numberSections);
    }
  });
});

describe('un seul format d’octets, et aucun champ calculé sur le disque', () => {
  /** Rétablit une date qui a le droit de bouger : le reste doit être identique à l'octet. */
  const sameBytesExcept = (before: string, field: 'lastOpenedAt' | 'updatedAt') => {
    const pattern = new RegExp(`"${field}": "[^"]*"`);
    const moved = readFileSync(projectFile, 'utf8');
    expect(moved.match(pattern)?.[0]).not.toBe(before.match(pattern)?.[0]);
    expect(moved.replace(pattern, '')).toBe(before.replace(pattern, ''));
  };

  it('ouvrir un projet : seul lastOpenedAt bouge, et ni bibliography ni cslPath résolus n’y entrent', async () => {
    writeProject(realisticProject());
    const before = readFileSync(projectFile, 'utf8');

    const result = await manager.loadProject(projectFile);

    expect(result.success).toBe(true);
    sameBytesExcept(before, 'lastOpenedAt');
    const disk = onDisk();
    expect(disk.bibliography).toBeUndefined();
    expect(disk.cslPath).toBe('style.csl');
    expect(disk.path).toBeUndefined();

    // Ce qui est résolu reste en mémoire, pour le reste de l'app.
    expect(result.project?.bibliography).toBe(path.join(projectDir, 'bibliography.bib'));
    expect(result.project?.cslPath).toBe(path.join(projectDir, 'style.csl'));
    expect(result.project?.path).toBe(projectDir);
  });

  it('un bibliography déjà sur le disque, ancien ou d’une version d’avant, n’en sort pas', async () => {
    writeProject(realisticProject({ bibliographySource: undefined, bibliography: '/ancien/chemin/biblio.bib' }));
    const before = readFileSync(projectFile, 'utf8');

    const result = await manager.loadProject(projectFile);

    sameBytesExcept(before, 'lastOpenedAt');
    expect(onDisk().bibliography).toBe('/ancien/chemin/biblio.bib');
    expect(result.project?.bibliography).toBe('/ancien/chemin/biblio.bib');
  });

  it.each<[string, () => Promise<{ success: boolean }>]>([
    ['saveProject', () => manager.saveProject({ path: projectFile, content: '' })],
    ['saveBookSettings', () => manager.saveBookSettings({ projectPath: projectFile, settings: {} })],
    [
      'saveChapters',
      () => manager.saveChapters({ projectPath: projectFile, chapters: [chapter('un', 0), chapter('deux', 1)] }),
    ],
    [
      'setBibliographySource',
      () =>
        manager.setBibliographySource({
          projectPath: projectFile,
          type: 'zotero',
          filePath: 'bibliography.bib',
          zoteroCollection: 'ABC',
        }),
    ],
    ['setCSLPath', () => manager.setCSLPath({ projectPath: projectFile, cslPath: path.join(projectDir, 'style.csl') })],
    ['updateConfig', () => manager.updateConfig(projectFile, {})],
  ])('%s sans rien changer : seul updatedAt bouge', async (_writer, write) => {
    writeProject(realisticProject());
    const before = readFileSync(projectFile, 'utf8');

    expect((await write()).success).toBe(true);

    sameBytesExcept(before, 'updatedAt');
  });

  it('recordProjectCollection : indentation 2, sans saut final, sans `path`, et rien si tout est à jour', async () => {
    writeProject(realisticProject({ path: '/un/ancien/dossier' }));
    const before = readFileSync(projectFile, 'utf8');

    // Déjà à jour : pas d'écriture, pas même pour retirer `path`.
    await recordProjectCollection(projectFile, 'bibliography.bib', 'ABC');
    expect(readFileSync(projectFile, 'utf8')).toBe(before);

    await recordProjectCollection(projectFile, 'bibliography.bib', 'XYZ');
    const text = readFileSync(projectFile, 'utf8');
    expect(text.endsWith('}')).toBe(true);
    expect(text).toContain('\n  "name": "Thèse"');
    expect(onDisk().path).toBeUndefined();
  });

  it('`path` n’entre jamais sur le disque, même envoyé par le renderer', async () => {
    writeProject(realisticProject());
    await manager.updateConfig(projectFile, { path: '/ailleurs', zotero: { collectionKey: 'XYZ' } } as never);
    expect(onDisk().path).toBeUndefined();
    expect(onDisk().zotero).toEqual({ collectionKey: 'XYZ', libraryID: 3 });
  });

  it('la mémoire se met à jour à partir du résultat, et garde ce qui est résolu', async () => {
    writeProject(realisticProject());
    await manager.loadProject(projectFile);

    await manager.saveChapters({ projectPath: projectFile, chapters: [chapter('trois', 0)] });
    await manager.saveBookSettings({ projectPath: projectFile, settings: { numberChapters: true } });
    await manager.updateConfig(projectFile, { zotero: { collectionKey: 'XYZ' } } as never);
    await manager.setBibliographySource({ projectPath: projectFile, type: 'file', filePath: 'autre.bib' });

    const current = manager.getCurrentProject() as unknown as Record<string, unknown>;
    expect((current.chapters as Array<{ id: string }>).map((c) => c.id)).toEqual(['trois']);
    expect((current.book as { numberChapters: boolean }).numberChapters).toBe(true);
    expect(current.zotero).toEqual({ collectionKey: 'XYZ', libraryID: 3 });
    expect(current.bibliographySource).toMatchObject({ type: 'file', filePath: 'autre.bib' });
    expect(current.path).toBe(projectDir);
    expect(current.bibliography).toBe(path.join(projectDir, 'bibliography.bib'));
    expect(current.cslPath).toBe(path.join(projectDir, 'style.csl'));
  });

  it('un projet voisin dont le nom commence pareil : la mémoire du projet courant ne bouge pas', async () => {
    writeProject(realisticProject());
    await manager.loadProject(projectFile);
    const neighbour = `${projectDir}-bis`;
    mkdirSync(neighbour);
    const neighbourFile = path.join(neighbour, 'project.json');
    writeFileSync(neighbourFile, JSON.stringify(realisticProject({ name: 'Voisin' })));

    await manager.updateConfig(neighbourFile, { zotero: { collectionKey: 'VOISIN' } } as never);

    const current = manager.getCurrentProject() as unknown as { name: string; path: string; zotero: unknown };
    expect(current.name).toBe('Thèse');
    expect(current.path).toBe(projectDir);
    expect(current.zotero).toEqual({ collectionKey: 'ABC', libraryID: 3 });
  });

  it.skipIf(!symlinkAvailable)('project.json lien symbolique : le lien reste, sa cible reçoit le texte', async () => {
    const target = path.join(workDir, 'manifeste.json');
    writeFileSync(target, JSON.stringify(realisticProject()));
    symlinkSync(target, projectFile);

    await manager.loadProject(projectFile);
    await manager.saveBookSettings({ projectPath: projectFile, settings: { numberChapters: true } });
    await manager.saveChapters({ projectPath: projectFile, chapters: [chapter('un', 0)] });
    await manager.updateConfig(projectFile, { zotero: { collectionKey: 'XYZ' } } as never);
    await manager.setCSLPath({ projectPath: projectFile });
    await manager.setBibliographySource({ projectPath: projectFile, type: 'file', filePath: 'a.bib' });
    await manager.createChapter({ projectPath: projectFile, title: 'Fin' });
    await manager.saveProject({ path: projectFile, content: '' });
    await recordProjectCollection(projectFile, 'b.bib', 'COLL');

    expect(lstatSync(projectFile).isSymbolicLink()).toBe(true);
    const disk = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect((disk.book as { numberChapters: boolean }).numberChapters).toBe(true);
    expect(disk.bibliographySource).toMatchObject({ filePath: 'b.bib' });
    expect(disk.chapters).toHaveLength(2);
  });
});

describe('un project.json illisible n’est jamais réécrit', () => {
  const writers: Array<[string, () => Promise<{ success: boolean; error?: string }>]> = [
    ['loadProject', () => manager.loadProject(projectFile)],
    ['saveProject', () => manager.saveProject({ path: projectFile, content: '' })],
    ['saveChapters', () => manager.saveChapters({ projectPath: projectFile, chapters: [] })],
    ['saveBookSettings', () => manager.saveBookSettings({ projectPath: projectFile, settings: {} })],
    ['createChapter', () => manager.createChapter({ projectPath: projectFile, title: 'X' })],
    ['setBibliographySource', () => manager.setBibliographySource({ projectPath: projectFile, type: 'file' })],
    ['updateConfig', () => manager.updateConfig(projectFile, { name: 'Autre' })],
    ['setCSLPath', () => manager.setCSLPath({ projectPath: projectFile })],
  ];

  describe.each<[string, string | Buffer]>([
    ['JSON invalide', '{ "name": "Thèse", }'],
    ['0 octet', ''],
    ['un tableau', '[]'],
    ['null', 'null'],
    ['un nombre', '42'],
    ['Latin-1', Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xc9, 0x22, 0x7d])],
  ])('%s', (_label, content) => {
    it.each(writers)('%s refuse, fichier identique à l’octet', async (_writer, write) => {
      writeFileSync(projectFile, content);
      const before = readFileSync(projectFile);

      const result = await write();

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(readFileSync(projectFile).equals(before)).toBe(true);
    });

    it('recordProjectCollection refuse, fichier identique à l’octet', async () => {
      writeFileSync(projectFile, content);
      const before = readFileSync(projectFile);
      // `null` se lit comme un manifeste absent : rien à écrire. Le reste lève.
      await recordProjectCollection(projectFile, 'b.bib', 'COLL').catch(() => undefined);
      expect(readFileSync(projectFile).equals(before)).toBe(true);
    });
  });

  it.each(writers)('absent : %s refuse, et ne crée rien', async (_writer, write) => {
    const result = await write();
    expect(result.success).toBe(false);
    expect(existsSync(projectFile)).toBe(false);
  });

  it('recordProjectCollection sur un fichier absent : rien à faire, rien de créé', async () => {
    await recordProjectCollection(projectFile, 'b.bib', 'COLL');
    expect(existsSync(projectFile)).toBe(false);
  });
});

describe('ouvrir B au project.json illisible (A35) : A reste, et rien de B ne bouge', () => {
  it('le projet courant reste A, sans migration de B', async () => {
    writeProject(realisticProject());
    await manager.loadProject(projectFile);
    vi.mocked(migrateWorkspaceToFlat).mockClear();

    const dirB = path.join(workDir, 'B');
    mkdirSync(dirB);
    const fileB = path.join(dirB, 'project.json');
    writeFileSync(fileB, '{ pas du JSON');

    const result = await manager.loadProject(fileB);

    expect(result.success).toBe(false);
    expect(manager.getCurrentProjectPath()).toBe(projectDir);
    expect(manager.getCurrentProject()?.name).toBe('Thèse');
    expect(migrateWorkspaceToFlat).not.toHaveBeenCalled();
    expect(readFileSync(fileB, 'utf8')).toBe('{ pas du JSON');
  });
});

describe('configIssue : le projet s’ouvre, et l’interface sait pourquoi le reste manque', () => {
  const configFile = () => path.join(projectDir, '.cliodeck', 'config.json');
  const writeConfig = (content: string) => {
    mkdirSync(path.join(projectDir, '.cliodeck'), { recursive: true });
    writeFileSync(configFile(), content);
  };

  it.each<[string, string, string]>([
    ['virgule en trop', '{"schema_version":2,"vault":{"path":"/Notes"},}', 'invalid_json'],
    ['format plus récent', '{"schema_version":3,"vault":{"path":"/Notes"}}', 'newer_schema'],
  ])('%s : ouvert, configIssue rendu, fichier intact', async (_label, content, kind) => {
    writeProject(realisticProject());
    writeConfig(content);

    const result = await manager.loadProject(projectFile);

    expect(result.success).toBe(true);
    expect(result.configIssue).toEqual({ kind, path: configFile() });
    expect(manager.getCurrentProjectPath()).toBe(projectDir);
    expect(readFileSync(configFile(), 'utf8')).toBe(content);
  });

  it('config.json lisible ou absent : pas de configIssue', async () => {
    writeProject(realisticProject());
    expect((await manager.loadProject(projectFile)).configIssue).toBeUndefined();
    writeConfig('{"schema_version":2}');
    expect((await manager.loadProject(projectFile)).configIssue).toBeUndefined();
  });
});

describe('getProjectMetadata : absent n’est pas indisponible', () => {
  const metadataOf = (file: string) => manager.getProjectMetadata(file) as Promise<{
    success: boolean;
    code?: string;
    error?: string;
    project?: { name: string; path: string };
  }>;

  it('un projet lisible : success, sans code, et rien ne s’écrit', async () => {
    writeProject(realisticProject());
    const before = readFileSync(projectFile, 'utf8');

    const result = await metadataOf(projectFile);

    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.project?.path).toBe(projectDir);
    expect(readFileSync(projectFile, 'utf8')).toBe(before);
  });

  it('dossier présent et lisible, project.json vraiment absent : project_file_missing', async () => {
    const result = await metadataOf(projectFile);
    expect(result).toMatchObject({ success: false, code: 'project_file_missing' });
  });

  it('iCloud a évincé le fichier (macOS < 14, `.project.json.icloud`) : project_unavailable', async () => {
    writeFileSync(path.join(projectDir, '.project.json.icloud'), 'bplist00');
    expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
  });

  it('dossier absent (disque débranché, parent renommé) : project_unavailable', async () => {
    const result = await metadataOf(path.join(workDir, 'NulPart', 'Thèse', 'project.json'));
    expect(result).toMatchObject({ success: false, code: 'project_unavailable' });
  });

  it('parent renommé puis rendu : indisponible, puis de nouveau lisible', async () => {
    writeProject(realisticProject());
    const parked = `${projectDir}-parti`;
    const { renameSync } = await import('fs');
    renameSync(projectDir, parked);
    expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    renameSync(parked, projectDir);
    expect(await metadataOf(projectFile)).toMatchObject({ success: true });
  });

  it.each<[string, string | Buffer]>([
    ['JSON invalide', '{ "name": "Thèse", '],
    ['0 octet', ''],
    ['des blancs', '  \n'],
    ['un tableau', '[]'],
    ['null', 'null'],
    ['Latin-1', Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0x22, 0xc9, 0x22, 0x7d])],
  ])('%s : project_unavailable, jamais retiré, jamais réécrit', async (_label, content) => {
    writeFileSync(projectFile, content);
    const before = readFileSync(projectFile);
    expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    expect(readFileSync(projectFile).equals(before)).toBe(true);
  });

  it.skipIf(!symlinkAvailable)(
    'lien project.json cassé (lié à un volume débranché) : ENOENT à la lecture, mais pas absent',
    async () => {
      symlinkSync(path.join(workDir, 'VolumeDebranche', 'project.json'), projectFile);
      expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    }
  );

  it.skipIf(!symlinkAvailable)('dossier du projet lien cassé : project_unavailable', async () => {
    const linked = path.join(workDir, 'LienCasse');
    symlinkSync(path.join(workDir, 'VolumeDebranche'), linked);
    expect(await metadataOf(path.join(linked, 'project.json'))).toMatchObject({
      success: false,
      code: 'project_unavailable',
    });
  });

  it('un élément du chemin est un fichier (ENOTDIR) : project_unavailable', async () => {
    const file = path.join(workDir, 'un-fichier');
    writeFileSync(file, 'x');
    expect(await metadataOf(path.join(file, 'project.json'))).toMatchObject({
      success: false,
      code: 'project_unavailable',
    });
  });

  it('un dossier à la place de project.json : project_unavailable', async () => {
    mkdirSync(projectFile);
    expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    rmSync(projectFile, { recursive: true });
  });

  it('OneDrive sans données locales (ETIMEDOUT) : project_unavailable', async () => {
    writeProject(realisticProject());
    h.statFailure = { file: projectFile, code: 'ETIMEDOUT' };
    expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
  });

  it.skipIf(IS_ROOT)('droits retirés sur le fichier (EACCES) : project_unavailable', async () => {
    writeProject(realisticProject());
    chmodSync(projectFile, 0o000);
    try {
      expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    } finally {
      chmodSync(projectFile, 0o644);
    }
  });

  it.skipIf(IS_ROOT)('dossier sans droit de lecture (EACCES) : project_unavailable', async () => {
    chmodSync(projectDir, 0o000);
    try {
      expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    } finally {
      chmodSync(projectDir, 0o755);
    }
  });

  it.skipIf(IS_ROOT)('dossier qu’on traverse sans pouvoir le lister : project_unavailable', async () => {
    chmodSync(projectDir, 0o311);
    try {
      expect(await metadataOf(projectFile)).toMatchObject({ success: false, code: 'project_unavailable' });
    } finally {
      chmodSync(projectDir, 0o755);
    }
  });

  it('l’erreur rendue n’est pas le code : c’est ce qu’elle dit qui peut s’afficher', async () => {
    writeFileSync(projectFile, '{ pas du JSON');
    const result = await metadataOf(projectFile);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe('project_unavailable');
  });
});
