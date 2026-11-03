/**
 * Chapitres multi-fichiers — modèle, manifeste et réconciliation (Phase 1).
 *
 * La chaîne « livre » n'avait aucune couverture : `getChapters` était un
 * stub qui fabriquait un chapitre imaginaire et `Project.chapters` n'était
 * jamais écrit. Ces tests verrouillent le contrat sur lequel la Phase 2
 * (panneau chapitres) et la Phase 4 (assemblage) vont s'appuyer.
 *
 * Le `ProjectManager` touche au disque et à `configManager` (electron-store)
 * : le second est remplacé par un espion en mémoire, le premier travaille
 * dans un dossier temporaire nettoyé après chaque test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, rename, symlink, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

vi.mock('../config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: vi.fn(() => []),
  },
}));

// La migration de workspace ouvre des ressources dont ces tests n'ont pas
// besoin ; elle est déjà couverte par ses propres suites.
vi.mock('../../../../backend/core/workspace/migrator.js', () => ({
  migrateWorkspaceToFlat: vi.fn(async () => ({
    kind: 'flat',
    copied: [],
    skipped: [],
    warnings: [],
  })),
}));

import { ProjectManager } from '../project-manager.js';
import { DEFAULT_BOOK_SETTINGS } from '../../../../backend/types/book.js';
import { atomicWriteFile } from '../../../../backend/core/fs/user-files.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

let workDir: string;
let manager: ProjectManager;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'cliodeck-book-'));
  manager = new ProjectManager();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Lit le project.json d'un projet créé dans `workDir`. */
async function readManifest(projectName: string) {
  const file = path.join(workDir, projectName, 'project.json');
  return JSON.parse(await readFile(file, 'utf-8'));
}

describe('createProject — squelette d’un livre', () => {
  it('crée chapters/01-introduction.md et le manifeste correspondant', async () => {
    const result = await manager.createProject({
      name: 'Danzig',
      type: 'book',
      path: workDir,
    });
    expect(result.success).toBe(true);

    const chapterFile = path.join(workDir, 'Danzig', 'chapters', '01-introduction.md');
    expect(existsSync(chapterFile)).toBe(true);
    // Le `#` du fichier EST le titre du chapitre (arbitrage 1).
    expect(await readFile(chapterFile, 'utf-8')).toContain('# Introduction');

    const manifest = await readManifest('Danzig');
    expect(manifest.chapters).toHaveLength(1);
    expect(manifest.chapters[0]).toMatchObject({
      title: 'Introduction',
      filePath: 'chapters/01-introduction.md',
      order: 0,
      kind: 'chapter',
    });
  });

  it('n’écrit PAS de document.md pour un livre (son texte vit dans chapters/)', async () => {
    await manager.createProject({ name: 'Danzig', type: 'book', path: workDir });
    expect(existsSync(path.join(workDir, 'Danzig', 'document.md'))).toBe(false);
    // abstract.md est conservé : résumé d'ouvrage (arbitrage 8).
    expect(existsSync(path.join(workDir, 'Danzig', 'abstract.md'))).toBe(true);
    expect(existsSync(path.join(workDir, 'Danzig', 'context.md'))).toBe(true);
  });

  it('écrit les réglages d’ouvrage par défaut', async () => {
    await manager.createProject({ name: 'Danzig', type: 'book', path: workDir });
    const manifest = await readManifest('Danzig');
    expect(manifest.book).toEqual(DEFAULT_BOOK_SETTINGS);
  });

  it('laisse les articles inchangés (document.md, pas de manifeste)', async () => {
    await manager.createProject({ name: 'Article', type: 'article', path: workDir });
    expect(existsSync(path.join(workDir, 'Article', 'document.md'))).toBe(true);
    expect(existsSync(path.join(workDir, 'Article', 'chapters'))).toBe(false);
    const manifest = await readManifest('Article');
    expect(manifest.chapters).toBeUndefined();
    expect(manifest.book).toBeUndefined();
  });
});

describe('saveProject — ne touche plus au markdown', () => {
  it('n’écrase pas document.md (il aurait écrasé un chapitre)', async () => {
    await manager.createProject({ name: 'Article', type: 'article', path: workDir });
    const projectFile = path.join(workDir, 'Article', 'project.json');
    const mdFile = path.join(workDir, 'Article', 'document.md');
    const before = await readFile(mdFile, 'utf-8');

    const result = await manager.saveProject({
      path: projectFile,
      content: 'CONTENU QUI NE DOIT PAS ATTERRIR SUR LE DISQUE',
    });

    expect(result.success).toBe(true);
    expect(await readFile(mdFile, 'utf-8')).toBe(before);
  });
});

describe('getChapters — réconciliation manifeste ↔ disque', () => {
  it('ordonne par `order` et accepte dossier comme project.json', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
    await writeFile(path.join(projectDir, 'chapters', 'a.md'), '# A\n');
    await writeFile(path.join(projectDir, 'chapters', 'b.md'), '# B\n');
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        name: 'Livre',
        type: 'book',
        chapters: [
          { id: '2', title: 'B', filePath: 'chapters/b.md', order: 1 },
          { id: '1', title: 'A', filePath: 'chapters/a.md', order: 0 },
        ],
      })
    );

    const byDir = await manager.getChapters(projectDir);
    expect(byDir.success).toBe(true);
    expect(byDir.chapters.map((c) => c.title)).toEqual(['A', 'B']);

    const byFile = await manager.getChapters(path.join(projectDir, 'project.json'));
    expect(byFile.chapters.map((c) => c.title)).toEqual(['A', 'B']);
  });

  it('marque `missing` sans jamais retirer l’entrée du manifeste', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
    await writeFile(path.join(projectDir, 'chapters', 'a.md'), '# A\n');
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        type: 'book',
        chapters: [
          { id: '1', title: 'A', filePath: 'chapters/a.md', order: 0 },
          { id: '2', title: 'Disparu', filePath: 'chapters/disparu.md', order: 1 },
        ],
      })
    );

    const result = await manager.getChapters(projectDir);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0].missing).toBeUndefined();
    expect(result.chapters[1]).toMatchObject({ title: 'Disparu', missing: true });
  });

  it('signale les fichiers non rattachés avec un titre suggéré', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
    await writeFile(path.join(projectDir, 'chapters', 'a.md'), '# A\n');
    await writeFile(
      path.join(projectDir, 'chapters', 'orphelin.md'),
      '# Chapitre oublié\n\nDu texte.\n'
    );
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        type: 'book',
        chapters: [{ id: '1', title: 'A', filePath: 'chapters/a.md', order: 0 }],
      })
    );

    const result = await manager.getChapters(projectDir);
    expect(result.unattached).toEqual([
      { filePath: 'chapters/orphelin.md', suggestedTitle: 'Chapitre oublié' },
    ]);
  });

  it('ne compte ni abstract.md ni context.md ni document.md comme orphelins', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'abstract.md'), '# Résumé\n');
    await writeFile(path.join(projectDir, 'context.md'), '# Contexte\n');
    await writeFile(path.join(projectDir, 'document.md'), '# Doc\n');
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ type: 'book', chapters: [] })
    );

    const result = await manager.getChapters(projectDir);
    expect(result.unattached).toEqual([]);
  });

  it('refuse une entrée dont le chemin sort du projet', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        type: 'book',
        chapters: [
          { id: '1', title: 'Évasion', filePath: '../../secrets.md', order: 0 },
          { id: '2', title: 'Absolu', filePath: '/etc/passwd', order: 1 },
        ],
      })
    );

    const result = await manager.getChapters(projectDir);
    expect(result.success).toBe(true);
    expect(result.chapters).toEqual([]);
  });

  it('retourne un manifeste vide (et non une erreur) sans project.json', async () => {
    const projectDir = path.join(workDir, 'Vide');
    await mkdir(projectDir, { recursive: true });

    const result = await manager.getChapters(projectDir);
    expect(result).toMatchObject({ success: true, chapters: [], unattached: [] });
  });
});

describe('createChapter / saveChapters / saveBookSettings', () => {
  async function makeBook() {
    await manager.createProject({ name: 'Livre', type: 'book', path: workDir });
    return path.join(workDir, 'Livre');
  }

  it('createChapter écrit le fichier ET l’entrée de manifeste', async () => {
    const projectDir = await makeBook();
    const result = await manager.createChapter({
      projectPath: projectDir,
      title: 'Élections de 1932',
    });

    expect(result.success).toBe(true);
    // Titre accentué → nom de fichier ASCII lisible.
    expect(result.chapter?.filePath).toBe('chapters/02-elections-de-1932.md');
    const abs = path.join(projectDir, result.chapter!.filePath);
    expect(await readFile(abs, 'utf-8')).toContain('# Élections de 1932');

    const manifest = JSON.parse(
      await readFile(path.join(projectDir, 'project.json'), 'utf-8')
    );
    expect(manifest.chapters).toHaveLength(2);
    expect(manifest.chapters[1].order).toBe(1);
  });

  it('createChapter ne réutilise jamais un nom de fichier existant', async () => {
    const projectDir = await makeBook();
    const first = await manager.createChapter({ projectPath: projectDir, title: 'Suite' });
    const second = await manager.createChapter({ projectPath: projectDir, title: 'Suite' });
    expect(first.chapter?.filePath).not.toBe(second.chapter?.filePath);
    expect(existsSync(path.join(projectDir, first.chapter!.filePath))).toBe(true);
    expect(existsSync(path.join(projectDir, second.chapter!.filePath))).toBe(true);
  });

  it('saveChapters renormalise l’ordre sur celui du tableau reçu', async () => {
    const projectDir = await makeBook();
    await manager.createChapter({ projectPath: projectDir, title: 'Deux' });
    const { chapters } = await manager.getChapters(projectDir);

    const reversed = [...chapters].reverse().map(({ missing: _m, ...c }) => c);
    const result = await manager.saveChapters({
      projectPath: projectDir,
      chapters: reversed,
    });

    expect(result.success).toBe(true);
    const after = await manager.getChapters(projectDir);
    expect(after.chapters.map((c) => c.title)).toEqual(['Deux', 'Introduction']);
    expect(after.chapters.map((c) => c.order)).toEqual([0, 1]);
  });

  it('saveChapters refuse un chemin qui sort du projet', async () => {
    const projectDir = await makeBook();
    const result = await manager.saveChapters({
      projectPath: projectDir,
      chapters: [{ id: 'x', title: 'Évasion', filePath: '../ailleurs.md', order: 0 }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes');
  });

  it('retirer un chapitre du manifeste laisse son fichier sur le disque', async () => {
    const projectDir = await makeBook();
    const { chapters } = await manager.getChapters(projectDir);
    const filePath = path.join(projectDir, chapters[0].filePath);

    await manager.saveChapters({ projectPath: projectDir, chapters: [] });

    const after = await manager.getChapters(projectDir);
    expect(after.chapters).toEqual([]);
    expect(existsSync(filePath)).toBe(true);
    // …et il réapparaît comme non rattaché : rien n'est perdu.
    expect(after.unattached.map((u) => u.filePath)).toContain(chapters[0].filePath);
  });

  it('saveBookSettings normalise et survit à un aller-retour disque', async () => {
    const projectDir = await makeBook();
    const result = await manager.saveBookSettings({
      projectPath: projectDir,
      settings: { noteStyle: 'endnote-chapter', bibliography: 'per-chapter' },
    });
    expect(result.success).toBe(true);

    const manifest = JSON.parse(
      await readFile(path.join(projectDir, 'project.json'), 'utf-8')
    );
    expect(manifest.book).toEqual({
      ...DEFAULT_BOOK_SETTINGS,
      noteStyle: 'endnote-chapter',
      bibliography: 'per-chapter',
    });
  });

  it('saveBookSettings ignore une valeur inconnue au profit du défaut', async () => {
    const projectDir = await makeBook();
    await manager.saveBookSettings({
      projectPath: projectDir,
      // Un project.json édité à la main ne doit pas pouvoir mettre l'export
      // dans un état impossible.
      settings: { noteStyle: 'marginalia' as never },
    });
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, 'project.json'), 'utf-8')
    );
    expect(manifest.book.noteStyle).toBe('footnote');
  });
});

describe('readChapters — un chapitre qui ne se lit pas ne se lit pas à moitié', () => {
  /** « # Été » en Latin-1. */
  const LATIN1 = Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]);
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  let projectDir: string;
  const fileOf = (rel: string) => path.join(projectDir, rel);

  beforeEach(async () => {
    projectDir = path.join(workDir, 'Livre');
    await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
  });

  it('Latin-1 : refusé avec sa raison, sans texte, et le fichier ne bouge pas', async () => {
    await writeFile(fileOf('chapters/01.md'), '# Un\n');
    await writeFile(fileOf('chapters/02.md'), LATIN1);

    const result = await manager.readChapters({
      projectPath: projectDir,
      filePaths: ['chapters/01.md', 'chapters/02.md'],
    });

    expect(result.success).toBe(true);
    expect(result.files[0]).toEqual({ filePath: 'chapters/01.md', content: '# Un\n' });
    expect(result.files[1]).toMatchObject({ filePath: 'chapters/02.md', reason: 'encoding' });
    expect(result.files[1].content).toBeUndefined();
    expect((await readFile(fileOf('chapters/02.md'))).equals(LATIN1)).toBe(true);
  });

  it('disparu : `absent`, et les autres sont lus dans l’ordre demandé', async () => {
    await writeFile(fileOf('chapters/01.md'), '# Un\n');
    await writeFile(fileOf('chapters/03.md'), '# Trois\n');

    const result = await manager.readChapters({
      projectPath: projectDir,
      filePaths: ['chapters/03.md', 'chapters/02.md', 'chapters/01.md'],
    });

    expect(result.files.map((f) => [f.filePath, f.content, f.reason])).toEqual([
      ['chapters/03.md', '# Trois\n', undefined],
      ['chapters/02.md', undefined, 'absent'],
      ['chapters/01.md', '# Un\n', undefined],
    ]);
  });

  it('un chemin qui sort du projet : `refused`, jamais lu', async () => {
    await writeFile(path.join(workDir, 'dehors.md'), '# Dehors\n');

    const result = await manager.readChapters({ projectPath: projectDir, filePaths: ['../dehors.md'] });

    expect(result.files[0]).toMatchObject({ filePath: '../dehors.md', reason: 'refused' });
    expect(result.files[0].content).toBeUndefined();
  });

  it('BOM : il reste dans le texte, l’écriture le retrouvera', async () => {
    await writeFile(fileOf('chapters/01.md'), Buffer.concat([BOM, Buffer.from('# Été\n', 'utf8')]));

    const result = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/01.md'] });

    expect(result.files[0].content).toBe('\uFEFF# Été\n');
  });

  it('une lecture demandée après une écriture lit ce que celle-ci a écrit', async () => {
    await writeFile(fileOf('chapters/01.md'), '# Avant\n');

    const writing = atomicWriteFile(fileOf('chapters/01.md'), '# Après\n');
    const reading = manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/01.md'] });
    await writing;

    expect((await reading).files[0].content).toBe('# Après\n');
  });
});

/**
 * Un projet se partage, et git comme zip conservent les liens : `chapters/annexe.md`
 * peut pointer vers `~/.ssh/config`. Décision Q16 : ce chapitre est marqué manquant,
 * ni lu ni indexé ; un lien qui reste dans le projet continue de marcher.
 */
describe.skipIf(!symlinkAvailable)('chapitre en lien symbolique', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  let projectDir: string;
  let outside: string;

  async function book(chapters: Array<{ id: string; title: string; filePath: string }>) {
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        type: 'book',
        name: 'Livre',
        chapters: chapters.map((c, order) => ({ ...c, order, kind: 'chapter' })),
      })
    );
  }

  beforeEach(async () => {
    projectDir = path.join(workDir, 'Livre');
    outside = path.join(workDir, 'dehors');
    await mkdir(path.join(projectDir, 'chapters'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'journal.md'), `# ${SECRET}\n\nTexte privé.\n`);
    await writeFile(path.join(projectDir, 'chapters', '01.md'), '# Un\n');
    await symlink(path.join(outside, 'journal.md'), path.join(projectDir, 'chapters', '02.md'));
  });

  const MANIFEST = [
    { id: '1', title: 'Un', filePath: 'chapters/01.md' },
    { id: '2', title: 'Annexe', filePath: 'chapters/02.md' },
  ];

  it('un lien qui sort du projet : marqué manquant, jamais lu', async () => {
    await book(MANIFEST);

    const { chapters } = await manager.getChapters(projectDir);
    expect(chapters[0].missing).toBeUndefined();
    expect(chapters[1]).toMatchObject({ title: 'Annexe', missing: true, outsideProject: true });

    const { files } = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/02.md'] });
    expect(files[0]).toMatchObject({ filePath: 'chapters/02.md', reason: 'refused' });
    expect(files[0].content).toBeUndefined();
    expect(JSON.stringify(files)).not.toContain(SECRET);
  });

  it('un lien qui reste dans le projet continue de marcher', async () => {
    await symlink('01.md', path.join(projectDir, 'chapters', '03.md'));
    await book([{ id: '3', title: 'Trois', filePath: 'chapters/03.md' }]);

    const { chapters } = await manager.getChapters(projectDir);
    expect(chapters[0].missing).toBeUndefined();
    expect(chapters[0].outsideProject).toBeUndefined();
    const { files } = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/03.md'] });
    expect(files[0].content).toBe('# Un\n');
  });

  it('une racine passée par un lien ne rend aucun chapitre manquant à tort', async () => {
    await book(MANIFEST);
    const alias = path.join(workDir, 'alias');
    await symlink(projectDir, alias);

    for (const opened of [alias, path.join(alias, 'project.json')]) {
      const { chapters } = await manager.getChapters(opened);
      expect(chapters[0].missing).toBeUndefined();
      expect(chapters[1]).toMatchObject({ missing: true, outsideProject: true });
      const { files } = await manager.readChapters({ projectPath: opened, filePaths: ['chapters/01.md'] });
      expect(files[0].content).toBe('# Un\n');
    }
  });

  it('`chapters` lié à l’intérieur du projet : les chapitres restent présents', async () => {
    const drafts = path.join(projectDir, 'brouillons');
    await rename(path.join(projectDir, 'chapters'), drafts);
    await rm(path.join(drafts, '02.md'));
    await symlink(drafts, path.join(projectDir, 'chapters'));
    await book([MANIFEST[0]]);

    const { chapters } = await manager.getChapters(projectDir);
    expect(chapters[0].missing).toBeUndefined();
    const { files } = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/01.md'] });
    expect(files[0].content).toBe('# Un\n');
  });

  it('`chapters` lié hors du projet : tout le dossier est manquant, rien n’est lu', async () => {
    await rm(path.join(projectDir, 'chapters'), { recursive: true });
    await symlink(outside, path.join(projectDir, 'chapters'));
    // Un fichier que le manifeste ne cite pas : son nom non plus ne doit pas remonter.
    await writeFile(path.join(outside, 'autre.md'), `# ${SECRET}\n`);
    await book([{ id: '1', title: 'Journal', filePath: 'chapters/journal.md' }]);

    const { chapters, unattached } = await manager.getChapters(projectDir);
    expect(chapters[0]).toMatchObject({ missing: true, outsideProject: true });
    expect(unattached).toEqual([]);
    const { files } = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/journal.md'] });
    expect(files[0].reason).toBe('refused');
    expect(files[0].content).toBeUndefined();
  });

  it('un lien cassé vers l’extérieur se distingue d’un lien cassé vers l’intérieur', async () => {
    await symlink(path.join(outside, 'pas-encore.md'), path.join(projectDir, 'chapters', 'dehors.md'));
    await symlink('pas-encore.md', path.join(projectDir, 'chapters', 'dedans.md'));
    await book([
      { id: 'd', title: 'Dehors', filePath: 'chapters/dehors.md' },
      { id: 'i', title: 'Dedans', filePath: 'chapters/dedans.md' },
    ]);

    const { chapters } = await manager.getChapters(projectDir);
    expect(chapters[0]).toMatchObject({ missing: true, outsideProject: true });
    expect(chapters[1].missing).toBe(true);
    expect(chapters[1].outsideProject).toBeUndefined();
  });

  it('la ligne survit à une réorganisation, à un renommage voisin et aux réglages', async () => {
    await book(MANIFEST);
    const { chapters } = await manager.getChapters(projectDir);
    // Ce qui arrive ici après `ChapterSchema`, qui retire les marques de réconciliation
    // (validation.test.ts) : le renderer, lui, renvoie `outsideProject` tel quel.
    const plain = chapters.map(({ missing: _m, outsideProject: _o, ...c }) => c);

    const reordered = await manager.saveChapters({ projectPath: projectDir, chapters: [plain[1], plain[0]] });
    expect(reordered.success).toBe(true);
    const renamed = await manager.saveChapters({
      projectPath: projectDir,
      chapters: [plain[1], { ...plain[0], title: 'Un, renommé' }],
    });
    expect(renamed.success).toBe(true);
    expect((await manager.saveBookSettings({ projectPath: projectDir, settings: { numberChapters: false } })).success).toBe(true);
    expect((await manager.createChapter({ projectPath: projectDir, title: 'Suite' })).success).toBe(true);

    const manifest = await readManifest('Livre');
    expect(manifest.chapters.map((c: { filePath: string }) => c.filePath).slice(0, 2)).toEqual([
      'chapters/02.md',
      'chapters/01.md',
    ]);
    expect(manifest.chapters[0].missing).toBeUndefined();
    expect(manifest.chapters[0].outsideProject).toBeUndefined();
  });

  it('un fichier réel rétabli à cet endroit rend son chapitre à l’auteur', async () => {
    await book(MANIFEST);
    expect((await manager.getChapters(projectDir)).chapters[1].missing).toBe(true);

    await rm(path.join(projectDir, 'chapters', '02.md'));
    await writeFile(path.join(projectDir, 'chapters', '02.md'), '# Annexe rétablie\n');

    const { chapters } = await manager.getChapters(projectDir);
    expect(chapters[1].missing).toBeUndefined();
    expect(chapters[1].outsideProject).toBeUndefined();
    const { files } = await manager.readChapters({ projectPath: projectDir, filePaths: ['chapters/02.md'] });
    expect(files[0].content).toBe('# Annexe rétablie\n');
  });

  it('un fichier non rattaché en lien sortant : ni son titre ni rien d’autre n’est lu', async () => {
    await book([MANIFEST[0]]);
    await writeFile(path.join(projectDir, 'chapters', '03.md'), '# Vrai titre\n');

    const { unattached } = await manager.getChapters(projectDir);
    const byPath = Object.fromEntries(unattached.map((f) => [f.filePath, f.suggestedTitle]));
    expect(byPath['chapters/03.md']).toBe('Vrai titre');
    expect(Object.keys(byPath)).toContain('chapters/02.md');
    expect(byPath['chapters/02.md']).toBeUndefined();
    expect(JSON.stringify(unattached)).not.toContain(SECRET);
  });

  it('createChapter n’écrit pas à travers un `chapters` lié hors du projet', async () => {
    await rm(path.join(projectDir, 'chapters'), { recursive: true });
    await symlink(outside, path.join(projectDir, 'chapters'));
    await book([]);

    const result = await manager.createChapter({ projectPath: projectDir, title: 'Neuf' });

    expect(result.success).toBe(false);
    expect(existsSync(path.join(outside, '01-neuf.md'))).toBe(false);
    expect((await readManifest('Livre')).chapters).toEqual([]);
  });

  it('createChapter ne prend pas un nom déjà occupé par un lien cassé vers l’extérieur', async () => {
    await book([]);
    await symlink(path.join(outside, 'cree-dehors.md'), path.join(projectDir, 'chapters', '01-neuf.md'));

    const result = await manager.createChapter({ projectPath: projectDir, title: 'Neuf' });

    expect(result.success).toBe(true);
    expect(existsSync(path.join(outside, 'cree-dehors.md'))).toBe(false);
    expect(result.chapter?.filePath).not.toBe('chapters/01-neuf.md');
  });
});

describe('loadProject — normalisation des réglages', () => {
  it('complète les réglages partiels et le manifeste absent', async () => {
    const projectDir = path.join(workDir, 'Livre');
    await mkdir(projectDir, { recursive: true });
    const projectFile = path.join(projectDir, 'project.json');
    await writeFile(
      projectFile,
      JSON.stringify({
        name: 'Livre',
        type: 'book',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        book: { noteStyle: 'endnote-book' },
      })
    );

    const result = await manager.loadProject(projectFile);
    expect(result.success).toBe(true);
    expect(result.project?.book).toEqual({
      ...DEFAULT_BOOK_SETTINGS,
      noteStyle: 'endnote-book',
    });
    expect(result.project?.chapters).toEqual([]);

    // La normalisation est persistée : le fichier ne reste pas partiel.
    const saved = JSON.parse(await readFile(projectFile, 'utf-8'));
    expect(saved.book.noteNumbering).toBe('continuous');
  });
});
