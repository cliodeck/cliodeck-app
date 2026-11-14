/**
 * Ce qu'un export PDF de livre laisse de côté se dit (S12-1-14).
 *
 * L'assemblage note les chapitres qu'il omet (fichier introuvable ou illisible, lien qui sort du
 * projet) : l'export PDF ne l'écrivait qu'en console. La bibliographie par chapitre lance citeproc
 * pièce par pièce : un échec y laissait les `[@clé]` brutes, puis la passe globale, sans
 * bibliographie, les imprimait telles quelles. Dans les deux cas : « Export terminé ! », sans un
 * mot. Le résultat porte désormais ces réserves (`warnings`), que la fenêtre affiche.
 *
 * Banc réel : vrai pandoc, vrai xelatex, par le vrai chemin d'export. Sans eux il est sauté (la CI
 * n'a ni l'un ni l'autre). Le style CSL cassé fait échouer citeproc sur chaque chapitre, comme le
 * ferait un style que l'auteur a mal copié : c'est un vrai échec de pandoc, pas un simulacre.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pdfExportService, type ExportOptions } from '../pdf-export.js';
import { DEFAULT_BOOK_SETTINGS, type BookSettings, type Chapter } from '../../../../backend/types/book.js';
import {
  pandocAvailable,
  pdftotextAvailable,
  toolEnv,
  xelatexAvailable,
} from '../../../../backend/__tests__/helpers/native-guards.js';

/** Large : xelatex charge les polices du système à chaque compilation. */
const COMPILE_MS = 120_000;

const BIBLIOGRAPHY = `@book{dupont2020,
  author = {Dupont, Jean},
  title = {Une histoire des archives},
  year = {2020},
  publisher = {Éditions du banc}
}
`;

describe.skipIf(!pandocAvailable() || !xelatexAvailable())('export PDF d’un livre : réserves', () => {
  let root = '';
  let project = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cliodeck-pdf-reserves-'));
    project = join(root, 'livre');
    mkdirSync(join(project, 'chapters'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function exportBook(chapters: Chapter[], extra: Partial<ExportOptions> = {}, book: Partial<BookSettings> = {}) {
    return pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'book',
      content: '',
      outputPath: join(project, 'livre.pdf'),
      metadata: { title: 'Livre', author: 'Autrice' },
      bookSettings: { ...DEFAULT_BOOK_SETTINGS, ...book },
      manuscript: { chapters },
      ...extra,
    });
  }

  it(
    'un chapitre introuvable, un autre hors du projet : le livre sort, et les deux sont nommés',
    async () => {
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nTEXTEPRESENT.\n');
      writeFileSync(join(root, 'dehors.md'), '# Dehors\n\nTEXTEDEHORS.\n');

      const result = await exportBook([
        { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
        { id: 'b', title: 'Disparu', filePath: 'chapters/02.md', order: 1 },
        { id: 'c', title: 'Dehors', filePath: '../dehors.md', order: 2 },
      ]);

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([
        { code: 'export.chapterUnreadable', params: { title: 'Disparu', file: 'chapters/02.md' } },
        { code: 'export.chapterOutsideProject', params: { title: 'Dehors', file: '../dehors.md' } },
      ]);
      if (pdftotextAvailable()) {
        const text = execFileSync('pdftotext', [join(project, 'livre.pdf'), '-'], { encoding: 'utf8', env: toolEnv() });
        expect(text).toContain('TEXTEPRESENT');
        expect(text).not.toContain('TEXTEDEHORS');
      }
    },
    COMPILE_MS
  );

  it(
    'citeproc échoue sur un chapitre (bibliographie par chapitre) : l’avertissement nomme le chapitre',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      // Un style tronqué : citeproc s'arrête sur « CiteprocXMLError », code 4.
      writeFileSync(join(project, 'style.csl'), '<style>tronqué');
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nVoir [@dupont2020].\n');
      writeFileSync(join(project, 'chapters', '02.md'), '# Suite\n\nEncore [@dupont2020].\n');

      const result = await exportBook(
        [
          { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Suite', filePath: 'chapters/02.md', order: 1 },
        ],
        { bibliographyPath: join(project, 'refs.bib'), cslPath: join(project, 'style.csl') },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([
        { code: 'export.chapterCitationsNotResolved', params: { title: 'Ouverture', file: 'chapters/01.md' } },
        { code: 'export.chapterCitationsNotResolved', params: { title: 'Suite', file: 'chapters/02.md' } },
      ]);
    },
    COMPILE_MS
  );

  /**
   * Revue de L09-12 : la réserve dit que des clés restent brutes. Un chapitre vide rend une sortie
   * vide avec le code 0 (mesuré : pandoc 3), et un chapitre sans clé n'en laisse aucune, même quand
   * le style fait échouer citeproc : ni l'un ni l'autre ne se nomme.
   */
  it(
    'citeproc échoue : seuls les chapitres qui ont des clés sont nommés, pas un chapitre vide ou sans citation',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      writeFileSync(join(project, 'style.csl'), '<style>tronqué');
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nVoir [@dupont2020].\n');
      writeFileSync(join(project, 'chapters', '02.md'), '# Sans citation\n\nUn texte, et `[@pasunecle]` en code.\n');
      writeFileSync(join(project, 'chapters', '03.md'), '\n\n');

      const result = await exportBook(
        [
          { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Sans citation', filePath: 'chapters/02.md', order: 1 },
          { id: 'c', title: 'Vide', filePath: 'chapters/03.md', order: 2 },
        ],
        { bibliographyPath: join(project, 'refs.bib'), cslPath: join(project, 'style.csl') },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([
        { code: 'export.chapterCitationsNotResolved', params: { title: 'Ouverture', file: 'chapters/01.md' } },
      ]);
    },
    COMPILE_MS
  );

  /**
   * Revue de L09-12, seconde passe : pandoc tient `@clé` nue pour une citation narrative, et
   * l'échec de citeproc la laisse brute dans le PDF. Elle compte quand la bibliographie connaît la
   * clé ; un pseudonyme (`@inactinique`), que la bibliographie ignore, ne nomme pas son chapitre.
   */
  it(
    'citeproc échoue : un chapitre aux seules citations narratives (@clé) est nommé, un pseudonyme ne l’est pas',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      writeFileSync(join(project, 'style.csl'), '<style>tronqué');
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nComme le montre @dupont2020, les archives parlent.\n');
      writeFileSync(join(project, 'chapters', '02.md'), '# Réseaux\n\nSuivre @inactinique, ou écrire à jean@example.org.\n');

      const result = await exportBook(
        [
          { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Réseaux', filePath: 'chapters/02.md', order: 1 },
        ],
        { bibliographyPath: join(project, 'refs.bib'), cslPath: join(project, 'style.csl') },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([
        { code: 'export.chapterCitationsNotResolved', params: { title: 'Ouverture', file: 'chapters/01.md' } },
      ]);
      if (pdftotextAvailable()) {
        const text = execFileSync('pdftotext', [join(project, 'livre.pdf'), '-'], { encoding: 'utf8', env: toolEnv() });
        // Ce que la réserve dit : la clé est restée brute.
        expect(text).toContain('@dupont2020');
      }
    },
    COMPILE_MS
  );

  it(
    'un chapitre vide, style valide : citeproc rend une sortie vide, ce n’est pas un échec',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nVoir [@dupont2020].\n');
      writeFileSync(join(project, 'chapters', '02.md'), '');

      const result = await exportBook(
        [
          { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Vide', filePath: 'chapters/02.md', order: 1 },
        ],
        { bibliographyPath: join(project, 'refs.bib') },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toBeUndefined();
    },
    COMPILE_MS
  );

  it(
    'citeproc réussit par chapitre : aucune réserve',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nVoir [@dupont2020].\n');

      const result = await exportBook(
        [{ id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 }],
        { bibliographyPath: join(project, 'refs.bib') },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toBeUndefined();
    },
    COMPILE_MS
  );

  it(
    'bibliographie par chapitre demandée, style intégré coché : la réserve dit qu’elle sera unique',
    async () => {
      writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
      writeFileSync(join(project, 'chapters', '01.md'), '# Ouverture\n\nUn texte.\n');

      const result = await exportBook(
        [{ id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 }],
        {
          bibliographyPath: join(project, 'refs.bib'),
          citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
        },
        { bibliography: 'per-chapter' }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([{ code: 'export.perChapterBibliographyIgnored' }]);
    },
    COMPILE_MS
  );
});
