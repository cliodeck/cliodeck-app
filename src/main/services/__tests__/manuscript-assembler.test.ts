import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { assembleManuscript } from '../manuscript-assembler';
import { DEFAULT_BOOK_SETTINGS, type Chapter } from '../../../../backend/types/book';

/**
 * Assemblage d'un manuscrit (plan chapitres, Phase 4, stratégie D).
 *
 * Le test cardinal est l'isolation des notes : deux chapitres utilisant
 * chacun `[^1]` doivent produire deux notes distinctes après assemblage —
 * sans quoi pandoc rend la même note aux deux endroits et le texte du
 * premier chapitre disparaît du livre imprimé (plan §1.1).
 */

let dir: string;

const CH = (over: Partial<Chapter> & { id: string; filePath: string }): Chapter => ({
  title: over.id,
  order: 0,
  kind: 'chapter',
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'assembler-'));
  await mkdir(path.join(dir, 'chapters'), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  await writeFile(path.join(dir, rel), content, 'utf-8');
}

describe('assembleManuscript', () => {
  it('isole les notes homonymes de deux chapitres', async () => {
    await write('chapters/01.md', '# Un\n\nAlpha[^1].\n\n[^1]: Note du chapitre un.\n');
    await write('chapters/02.md', '# Deux\n\nBeta[^1].\n\n[^1]: Note du chapitre deux.\n');

    const { markdown, chapterCount } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/02.md', order: 1 }),
      ],
    });

    expect(chapterCount).toBe(2);
    expect(markdown).toContain('[^ch1-1]: Note du chapitre un.');
    expect(markdown).toContain('[^ch2-1]: Note du chapitre deux.');
    // Plus aucun label nu : les deux espaces de noms sont disjoints.
    expect(markdown).not.toMatch(/\[\^1\]/);
  });

  it('respecte l’ordre du manifeste et regroupe par kind', async () => {
    await write('chapters/01.md', '# Corps\n');
    await write('preface.md', '# Preface\n');
    await write('annexes.md', '# Annexes\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [
        CH({ id: 'c', filePath: 'chapters/01.md', order: 5 }),
        CH({ id: 'z', filePath: 'annexes.md', order: 9, kind: 'back' }),
        CH({ id: 'p', filePath: 'preface.md', order: 1, kind: 'front' }),
      ],
    });

    expect(markdown.indexOf('# Preface')).toBeLessThan(markdown.indexOf('# Corps'));
    expect(markdown.indexOf('# Corps')).toBeLessThan(markdown.indexOf('# Annexes'));
  });

  it('ne touche pas aux notes des blocs de code', async () => {
    await write(
      'chapters/01.md',
      '# Un\n\nAlpha[^1].\n\n```md\n[^99]: pas une note\n```\n\n[^1]: Vraie note.\n'
    );

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [CH({ id: 'a', filePath: 'chapters/01.md', order: 0 })],
    });

    expect(markdown).toContain('[^99]: pas une note');
    expect(markdown).toContain('[^ch1-1]: Vraie note.');
  });

  it('le texte vivant de l’éditeur prime sur le disque', async () => {
    await write('chapters/01.md', '# Disque\n\nVersion enregistree.\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [CH({ id: 'a', filePath: 'chapters/01.md', order: 0 })],
      liveOverrides: { 'chapters/01.md': '# Editeur\n\nFrappe non sauvegardee.\n' },
    });

    expect(markdown).toContain('Frappe non sauvegardee.');
    expect(markdown).not.toContain('Version enregistree.');
  });

  it('signale un chapitre illisible sans interrompre l’assemblage', async () => {
    await write('chapters/01.md', '# Un\n');

    const { markdown, chapterCount, warnings } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/absent.md', order: 1 }),
      ],
    });

    expect(chapterCount).toBe(1);
    expect(markdown).toContain('# Un');
    expect(warnings.some((w) => w.includes('absent.md'))).toBe(true);
  });

  it('refuse un chemin qui sort du projet', async () => {
    const { chapterCount, warnings } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [CH({ id: 'x', filePath: '../evade.md', order: 0 })],
    });

    expect(chapterCount).toBe(0);
    expect(warnings.some((w) => w.includes('hors projet'))).toBe(true);
  });

  it('scope chapitre : tirage de travail limité à une pièce', async () => {
    await write('chapters/01.md', '# Un\n');
    await write('chapters/02.md', '# Deux\n');

    const { markdown, chapterCount } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/02.md', order: 1 }),
      ],
      scope: { chapterId: 'b' },
    });

    expect(chapterCount).toBe(1);
    expect(markdown).toContain('# Deux');
    expect(markdown).not.toContain('# Un');
  });

  it('notes de fin de chapitre : un vidage après chaque pièce', async () => {
    await write('chapters/01.md', '# Un\n\nAlpha[^1].\n\n[^1]: Note.\n');
    await write('chapters/02.md', '# Deux\n\nBeta[^1].\n\n[^1]: Note.\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: { ...DEFAULT_BOOK_SETTINGS, noteStyle: 'endnote-chapter' },
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/02.md', order: 1 }),
      ],
    });

    expect(markdown.match(/\\theendnotes/g)).toHaveLength(2);
  });

  it('notes de fin d’ouvrage : un seul vidage, à la fin', async () => {
    await write('chapters/01.md', '# Un\n\nAlpha[^1].\n\n[^1]: Note.\n');
    await write('chapters/02.md', '# Deux\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: { ...DEFAULT_BOOK_SETTINGS, noteStyle: 'endnote-book' },
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/02.md', order: 1 }),
      ],
    });

    expect(markdown.match(/\\theendnotes/g)).toHaveLength(1);
    expect(markdown.trimEnd().endsWith('\\theendnotes')).toBe(true);
  });

  it('numérotation par chapitre : compteur remis à zéro à chaque pièce', async () => {
    await write('chapters/01.md', '# Un\n');
    await write('chapters/02.md', '# Deux\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: { ...DEFAULT_BOOK_SETTINGS, noteNumbering: 'per-chapter' },
      chapters: [
        CH({ id: 'a', filePath: 'chapters/01.md', order: 0 }),
        CH({ id: 'b', filePath: 'chapters/02.md', order: 1 }),
      ],
    });

    expect(markdown.match(/\\setcounter\{footnote\}\{0\}/g)).toHaveLength(2);
  });

  it('transformChapter s’applique AVANT le préfixage', async () => {
    await write('chapters/01.md', '# Un\n\nTexte.\n');

    const { markdown } = await assembleManuscript({
      projectPath: dir,
      settings: DEFAULT_BOOK_SETTINGS,
      chapters: [CH({ id: 'a', filePath: 'chapters/01.md', order: 0 })],
      // Simule citeproc : la transformation ajoute une note, qui doit être
      // préfixée comme les autres.
      transformChapter: async (content) =>
        content + '\nCitation[^1].\n\n[^1]: Reference generee.\n',
    });

    expect(markdown).toContain('[^ch1-1]: Reference generee.');
    expect(markdown).not.toMatch(/\[\^1\]/);
  });
});
