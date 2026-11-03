import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

/**
 * Step `export` d'une recette dans un projet « livre ».
 *
 * Avant : le handler lisait UN fichier (défaut `document.md`) et forçait
 * `projectType: 'article'`. Dans un livre, une recette exportait donc un
 * chapitre isolé, en mauvaise classe de document.
 */
const exportCalls: Array<{ projectType: string; content: string }> = [];

vi.mock('../pdf-export.js', () => ({
  pdfExportService: {
    exportToPDF: vi.fn(async (opts: { projectType: string; content: string; outputPath?: string }) => {
      exportCalls.push({ projectType: opts.projectType, content: opts.content });
      return { success: true, outputPath: opts.outputPath };
    }),
  },
}));

const { recipeStepHandlers } = await import('../recipe-step-handlers');

async function makeProject(type: 'article' | 'book', withChapters: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'cliodeck-recipe-'));
  const manifest: Record<string, unknown> = { name: 'T', type, path: dir };
  if (withChapters) {
    await mkdir(join(dir, 'chapters'), { recursive: true });
    await writeFile(join(dir, 'chapters/01.md'), '# Un\n\nTexte un.\n');
    await writeFile(join(dir, 'chapters/02.md'), '# Deux\n\nTexte deux.\n');
    manifest.chapters = [
      { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
      { id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
    ];
  }
  await writeFile(join(dir, 'document.md'), '# Solo\n\nFichier unique.\n');
  await writeFile(join(dir, 'project.json'), JSON.stringify(manifest));
  return dir;
}

const runStep = (dir: string, withArgs: Record<string, unknown>) =>
  recipeStepHandlers.export(
    { id: 's', kind: 'export', with: { output: join(dir, 'out.pdf'), ...withArgs } } as never,
    { workspaceRoot: dir } as never
  );

describe('recette : step export dans un livre', () => {
  beforeEach(() => {
    exportCalls.length = 0;
  });

  it('assemble tout le manuscrit et transmet le type book', async () => {
    const dir = await makeProject('book', true);
    await runStep(dir, {});
    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0].projectType).toBe('book');
    expect(exportCalls[0].content).toContain('Texte un.');
    expect(exportCalls[0].content).toContain('Texte deux.');
    await rm(dir, { recursive: true, force: true });
  });

  it('respecte un document_id explicite, même dans un livre', async () => {
    const dir = await makeProject('book', true);
    await runStep(dir, { document_id: 'chapters/02.md' });
    expect(exportCalls[0].content).toContain('Texte deux.');
    expect(exportCalls[0].content).not.toContain('Texte un.');
    expect(exportCalls[0].projectType).toBe('book');
    await rm(dir, { recursive: true, force: true });
  });

  it('garde le comportement historique pour un article', async () => {
    const dir = await makeProject('article', false);
    await runStep(dir, {});
    expect(exportCalls[0].projectType).toBe('article');
    expect(exportCalls[0].content).toContain('Fichier unique.');
    await rm(dir, { recursive: true, force: true });
  });

  it('retombe sur document.md quand le projet n’a pas de manifeste', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cliodeck-recipe-'));
    await writeFile(join(dir, 'document.md'), '# Sans manifeste\n');
    await runStep(dir, {});
    expect(exportCalls[0].projectType).toBe('article');
    expect(exportCalls[0].content).toContain('Sans manifeste');
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Décision Q16 : un fichier lié hors du projet n'est pas lu. La branche « livre entier »
 * passe par la garde de l'assembleur ; un document nommé, ou le `document.md` d'un
 * article, était lu tel quel.
 */
describe.skipIf(!symlinkAvailable)('recette : un document en lien symbolique', () => {
  const SECRET = 'SECRET-HORS-PROJET';
  let outside: string;
  const projects: string[] = [];

  async function project(type: 'article' | 'book', withChapters: boolean): Promise<string> {
    const dir = await makeProject(type, withChapters);
    projects.push(dir);
    return dir;
  }

  async function linkOut(dir: string, relPath: string): Promise<void> {
    await rm(join(dir, relPath));
    await symlink(join(outside, 'journal.md'), join(dir, relPath));
  }

  beforeEach(async () => {
    exportCalls.length = 0;
    outside = await mkdtemp(join(tmpdir(), 'cliodeck-recipe-dehors-'));
    await writeFile(join(outside, 'journal.md'), `# Journal\n\n${SECRET} : texte privé.\n`);
  });

  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
    for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('un chapitre nommé par document_id : refusé, rien ne part à l’export', async () => {
    const dir = await project('book', true);
    await linkOut(dir, 'chapters/02.md');

    await expect(runStep(dir, { document_id: 'chapters/02.md' })).rejects.toThrow(/leaves the workspace/);
    expect(exportCalls).toHaveLength(0);
  });

  it('le document.md d’un article : refusé aussi', async () => {
    const dir = await project('article', false);
    await linkOut(dir, 'document.md');

    await expect(runStep(dir, {})).rejects.toThrow(/leaves the workspace/);
    expect(exportCalls).toHaveLength(0);
  });

  it('un lien cassé vers l’extérieur : refusé pour ce qu’il est, pas comme un fichier illisible', async () => {
    const dir = await project('article', false);
    await rm(join(dir, 'document.md'));
    await symlink(join(outside, 'pas-encore.md'), join(dir, 'document.md'));

    await expect(runStep(dir, {})).rejects.toThrow(/leaves the workspace/);
  });

  it('le livre entier ne lit pas document.md : un tel lien ne l’empêche pas de s’exporter', async () => {
    const dir = await project('book', true);
    await linkOut(dir, 'document.md');

    await runStep(dir, {});

    expect(exportCalls[0].content).toContain('Texte un.');
    expect(exportCalls[0].content).not.toContain(SECRET);
  });

  it('un lien qui reste dans le projet s’exporte', async () => {
    const dir = await project('book', true);
    await symlink('01.md', join(dir, 'chapters', 'copie.md'));

    await runStep(dir, { document_id: 'chapters/copie.md' });

    expect(exportCalls[0].content).toContain('Texte un.');
  });

  it('une racine passée par un lien ne fait rien refuser à tort', async () => {
    const dir = await project('article', false);
    const alias = `${dir}-alias`;
    await symlink(dir, alias);
    projects.push(alias);

    await runStep(alias, {});

    expect(exportCalls[0].content).toContain('Fichier unique.');
  });
});
