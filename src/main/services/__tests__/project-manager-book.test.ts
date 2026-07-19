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
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
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
