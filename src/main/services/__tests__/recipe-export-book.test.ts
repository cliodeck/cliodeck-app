import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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
