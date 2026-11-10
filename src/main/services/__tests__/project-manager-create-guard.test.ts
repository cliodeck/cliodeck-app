/**
 * Créer un projet ne doit jamais écraser ce qui existe (S11-1-0).
 *
 * `createProject` écrivait ses gabarits sans regarder : taper le nom d'un
 * projet existant remplaçait son document.md par « # Nom », son project.json
 * (bibliographie, CSL, manifeste des chapitres) et son context.md.
 *
 * Même dispositif que project-manager-book.test.ts : vrai disque dans un
 * dossier temporaire, `configManager` et la migration remplacés.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, symlink, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const { addRecentProject, migrateWorkspaceToFlat } = vi.hoisted(() => ({
  addRecentProject: vi.fn(),
  migrateWorkspaceToFlat: vi.fn(async () => ({ kind: 'flat', copied: [], skipped: [], warnings: [] })),
}));

vi.mock('../config-manager.js', () => ({
  configManager: {
    addRecentProject,
    removeRecentProject: vi.fn(),
    getRecentProjects: vi.fn(() => []),
  },
}));

vi.mock('../../../../backend/core/workspace/migrator.js', () => ({ migrateWorkspaceToFlat }));

import { ProjectManager } from '../project-manager.js';

let workDir: string;
let manager: ProjectManager;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'cliodeck-create-guard-'));
  manager = new ProjectManager();
  addRecentProject.mockClear();
  migrateWorkspaceToFlat.mockClear();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Tout le contenu d'un dossier, chemin relatif → octets, pour comparer avant/après. */
async function snapshot(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await snapshot(full, rel));
    else out[rel] = (await readFile(full)).toString('base64');
  }
  return out;
}

describe('createProject — le dossier porte déjà un `.cliodeck`', () => {
  const inDir = async (config: string) => {
    const dir = path.join(workDir, 'Neuf');
    await mkdir(path.join(dir, '.cliodeck'), { recursive: true });
    const file = path.join(dir, '.cliodeck', 'config.json');
    await writeFile(file, config);
    return file;
  };

  it.each<[string, string, string]>([
    ['virgule en trop', '{"schema_version":2,"vault":{"path":"/Notes"},}', 'invalid_json'],
    ['format plus récent', '{"schema_version":3,"vault":{"path":"/Notes"}}', 'newer_schema'],
  ])('%s : créé, l’auteur le saura, et config.json reste identique à l’octet', async (_label, config, kind) => {
    const file = await inDir(config);
    const before = await readFile(file);

    const result = await manager.createProject({ name: 'Neuf', type: 'article', path: workDir });

    expect(result).toMatchObject({ success: true, configIssue: { kind, path: file } });
    expect((await readFile(file)).equals(before)).toBe(true);
  });

  it('témoin : un config.json qui se lit, ou aucun, ne signale rien', async () => {
    await inDir('{"schema_version":2}');
    const withConfig = await manager.createProject({ name: 'Neuf', type: 'article', path: workDir });
    expect(withConfig.success).toBe(true);
    expect(withConfig).not.toHaveProperty('configIssue');

    const without = await manager.createProject({ name: 'Autre', type: 'article', path: workDir });
    expect(without.success).toBe(true);
    expect(without).not.toHaveProperty('configIssue');
  });
});

describe('createProject — un projet existe déjà à cet emplacement', () => {
  it('article : refus project_exists, tous les fichiers intacts', async () => {
    await manager.createProject({ name: 'These', type: 'article', path: workDir });
    const dir = path.join(workDir, 'These');
    await writeFile(path.join(dir, 'document.md'), '# These\n\nTrois ans de travail.\n');
    await writeFile(path.join(dir, 'context.md'), 'Ma problématique.\n');
    const manifest = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8'));
    manifest.bibliographySource = { type: 'file', filePath: 'bibliography.bib' };
    await writeFile(path.join(dir, 'project.json'), JSON.stringify(manifest, null, 2));
    const before = await snapshot(dir);

    const fresh = new ProjectManager();
    addRecentProject.mockClear();
    migrateWorkspaceToFlat.mockClear();
    const result = await fresh.createProject({ name: 'These', type: 'article', path: workDir });

    expect(result).toEqual({ success: false, error: 'project_exists' });
    expect(await snapshot(dir)).toEqual(before);
    expect(fresh.getCurrentProjectPath()).toBeNull();
    expect(addRecentProject).not.toHaveBeenCalled();
    expect(migrateWorkspaceToFlat).not.toHaveBeenCalled();
  });

  it('le projet ouvert reste le projet courant après un refus', async () => {
    await manager.createProject({ name: 'Ouvert', type: 'article', path: workDir });
    await manager.createProject({ name: 'These', type: 'article', path: workDir });
    const current = manager.getCurrentProjectPath();

    const result = await manager.createProject({ name: 'Ouvert', type: 'article', path: workDir });

    expect(result.success).toBe(false);
    expect(manager.getCurrentProjectPath()).toBe(current);
  });

  it('livre : premier chapitre et manifeste intacts, même demandé sous un autre type', async () => {
    await manager.createProject({ name: 'Danzig', type: 'book', path: workDir });
    const dir = path.join(workDir, 'Danzig');
    await writeFile(path.join(dir, 'chapters', '01-introduction.md'), '# Introduction\n\nDéjà écrit.\n');
    const before = await snapshot(dir);

    for (const type of ['book', 'article', 'presentation']) {
      const result = await manager.createProject({ name: 'Danzig', type, path: workDir });
      expect(result).toEqual({ success: false, error: 'project_exists' });
    }
    expect(await snapshot(dir)).toEqual(before);
  });
});

describe('createProject — des fichiers existent sans project.json', () => {
  it('article : document.md seul suffit à refuser, rien n’est créé', async () => {
    const dir = path.join(workDir, 'Brouillon');
    await mkdir(dir);
    await writeFile(path.join(dir, 'document.md'), 'Un texte à garder.\n');
    const before = await snapshot(dir);

    const result = await manager.createProject({ name: 'Brouillon', type: 'article', path: workDir });

    expect(result).toEqual({ success: false, error: 'project_files_exist' });
    expect(await snapshot(dir)).toEqual(before);
    expect(manager.getCurrentProjectPath()).toBeNull();
    expect(migrateWorkspaceToFlat).not.toHaveBeenCalled();
  });

  it('présentation : slides.md protégé', async () => {
    const dir = path.join(workDir, 'Colloque');
    await mkdir(dir);
    await writeFile(path.join(dir, 'slides.md'), '## Mes diapositives\n');
    const before = await snapshot(dir);

    const result = await manager.createProject({ name: 'Colloque', type: 'presentation', path: workDir });

    expect(result).toEqual({ success: false, error: 'project_files_exist' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('livre : un chapitre 01-introduction.md protégé', async () => {
    const dir = path.join(workDir, 'Ouvrage');
    await mkdir(path.join(dir, 'chapters'), { recursive: true });
    await writeFile(path.join(dir, 'chapters', '01-introduction.md'), '# Introduction\n\nÀ garder.\n');
    const before = await snapshot(dir);

    const result = await manager.createProject({ name: 'Ouvrage', type: 'book', path: workDir });

    expect(result).toEqual({ success: false, error: 'project_files_exist' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('écriture impossible en cours de route : seul ce que l’appel a créé est retiré', async () => {
    // Un lien cassé passe le contrôle d'existence, mais pas l'ouverture
    // exclusive : c'est le cas d'un fichier apparu entre le contrôle et l'écriture.
    const dir = path.join(workDir, 'Course');
    await mkdir(dir);
    await writeFile(path.join(dir, 'notes.txt'), 'À moi.\n');
    await symlink(path.join(dir, 'disparu.md'), path.join(dir, 'context.md'));

    const result = await manager.createProject({ name: 'Course', type: 'article', path: workDir });

    expect(result).toEqual({ success: false, error: 'project_files_exist' });
    expect(existsSync(path.join(dir, 'document.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'abstract.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'project.json'))).toBe(false);
    expect((await lstat(path.join(dir, 'context.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(dir, 'notes.txt'), 'utf-8')).toBe('À moi.\n');
    expect(manager.getCurrentProjectPath()).toBeNull();
    expect(addRecentProject).not.toHaveBeenCalled();
  });

  it('`chapters` est un fichier : le livre échoue sans rien laisser', async () => {
    const dir = path.join(workDir, 'Neuf');
    await mkdir(dir);
    await writeFile(path.join(dir, 'chapters'), 'pas un dossier\n');

    await expect(manager.createProject({ name: 'Neuf', type: 'book', path: workDir })).rejects.toThrow();

    expect(existsSync(path.join(dir, 'project.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'abstract.md'))).toBe(false);
    expect(await readFile(path.join(dir, 'chapters'), 'utf-8')).toBe('pas un dossier\n');
  });
});

describe('createProject — non-régression', () => {
  it('un dossier neuf se crée normalement, project.json compris', async () => {
    const result = await manager.createProject({ name: 'Neuf', type: 'article', path: workDir });

    expect(result.success).toBe(true);
    const dir = path.join(workDir, 'Neuf');
    expect(await readFile(path.join(dir, 'document.md'), 'utf-8')).toBe('# Neuf');
    expect(existsSync(path.join(dir, 'abstract.md'))).toBe(true);
    expect(existsSync(path.join(dir, 'context.md'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8')).name).toBe('Neuf');
    // Créé, pas ouvert : `project:create` l'ouvre ensuite par la séquence, services compris (L03-3).
    expect(manager.getCurrentProjectPath()).toBeNull();
    expect(result).toMatchObject({ path: path.join(dir, 'project.json') });
    expect(addRecentProject).toHaveBeenCalledWith(path.join(dir, 'project.json'));
    expect(migrateWorkspaceToFlat).toHaveBeenCalledWith(dir);
  });

  it('un dossier existant sans fichier en conflit reste utilisable', async () => {
    const dir = path.join(workDir, 'Existant');
    await mkdir(dir);
    await writeFile(path.join(dir, 'notes.txt'), 'À moi.\n');

    const result = await manager.createProject({ name: 'Existant', type: 'article', path: workDir });

    expect(result.success).toBe(true);
    expect(await readFile(path.join(dir, 'notes.txt'), 'utf-8')).toBe('À moi.\n');
    expect(existsSync(path.join(dir, 'project.json'))).toBe(true);
  });

  it('une présentation garde ses trois fichiers', async () => {
    const result = await manager.createProject({ name: 'Colloque', type: 'presentation', path: workDir });

    expect(result.success).toBe(true);
    const dir = path.join(workDir, 'Colloque');
    expect(existsSync(path.join(dir, 'document.md'))).toBe(true);
    expect(await readFile(path.join(dir, 'slides.md'), 'utf-8')).toContain('## Colloque');
    expect(existsSync(path.join(dir, 'abstract.md'))).toBe(false);
  });
});
