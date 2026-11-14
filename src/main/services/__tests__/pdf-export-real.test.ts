/**
 * Citations dans le PDF (L10-5) : italiques, titre de la bibliographie, clés introuvables.
 *
 * S12-1-7 : case « style intégré » cochée (elle l'est d'office dès qu'un style est enregistré),
 * l'export recopiait tels quels les notes et la bibliographie du moteur, que citeproc rend en HTML.
 * L'écrivain LaTeX de pandoc supprime ces balises : aucun titre d'ouvrage en italique, une
 * bibliographie à puces sous « Bibliographie », en français quelle que soit la langue, et une clé
 * mal tapée imprimée `[@Dupnt_2020]` sans un mot.
 *
 * S12-1-11 : sans le moteur, pandoc ne titre la bibliographie que si `reference-section-title`
 * lui est passé, ce qui n'était fait que sans style CSL, et jamais pour la bibliographie par
 * chapitre. Passé par chapitre, le titre sort en `#` : sans `demoteChapterBibliographyHeading`,
 * chaque chapitre serait suivi d'un faux chapitre « Références ».
 *
 * Banc réel : vrai pandoc (3.13 sur le Mac de l'auteur), vrai xelatex, par le vrai chemin
 * d'export ; le fichier produit est relu par pdftotext et pdffonts (Poppler). Sans pandoc ou sans
 * xelatex il est sauté : la CI n'a ni l'un ni l'autre.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pdfExportService, type ExportOptions, type PDFExportResult } from '../pdf-export.js';
import { ExportClock } from '../export-time-limit.js';
import { bibliographyService } from '../bibliography-service.js';
import { setLanguage } from '../../i18n.js';
import { CitationEngine } from '../../../../backend/core/citation/CitationEngine.js';
import { DEFAULT_BOOK_SETTINGS, type Chapter } from '../../../../backend/types/book.js';
import {
  pandocAvailable,
  pdftotextAvailable,
  toolEnv,
  xelatexAvailable,
} from '../../../../backend/__tests__/helpers/native-guards.js';

/** Large : xelatex charge les polices du système à chaque compilation. */
const COMPILE_MS = 120_000;

const BIBLIOGRAPHY = `@book{Farge_2013,
  author = {Farge, Arlette},
  title = {The Allure of the Archives},
  year = {2013},
  publisher = {Yale University Press}
}
`;

/** Le style Chicago (notes) que l'app embarque, celui du moteur. */
const CHICAGO_CSL = new CitationEngine().stylePath('chicago-note-bibliography')!;

/** Le passage de citeproc sur un chapitre, privé : le banc le lance tel que l'export le lance. */
type ResolveChapter = (
  content: string,
  opts: { bibliographyPath: string; cslPath?: string; tempDir: string; clock: ExportClock }
) => Promise<{ content: string; resolved: boolean; missing?: string[] }>;

const resolveCitationsInChapter: ResolveChapter = (content, opts) =>
  (pdfExportService as unknown as { resolveCitationsInChapter: ResolveChapter }).resolveCitationsInChapter(
    content,
    opts
  );

function pdfText(pdf: string): string {
  return execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8', env: toolEnv() });
}

let root = '';
let project = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cliodeck-pdf-citations-'));
  project = join(root, 'projet');
  mkdirSync(join(project, 'chapters'), { recursive: true });
  writeFileSync(join(project, 'refs.bib'), BIBLIOGRAPHY);
  copyFileSync(CHICAGO_CSL, join(project, 'chicago.csl'));
});
afterEach(() => {
  setLanguage('fr');
  bibliographyService.forget();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!pandocAvailable())('citeproc par chapitre (bibliographie par chapitre)', () => {
  it.each([
    { name: 'avec le style du projet', csl: true },
    { name: 'avec le style par défaut de pandoc', csl: false },
  ])('$name : le chapitre garde un seul titre de niveau 1, sa bibliographie est titrée dessous', async ({ csl }) => {
    const clock = new ExportClock(60_000);
    try {
      const result = await resolveCitationsInChapter(
        '# Ouverture\n\nTexte [@Farge_2013] et faute [@Dupnt_2020].\n',
        {
          bibliographyPath: join(project, 'refs.bib'),
          cslPath: csl ? join(project, 'chicago.csl') : undefined,
          tempDir: root,
          clock,
        }
      );

      expect(result.resolved).toBe(true);
      expect(result.content.match(/^# .*$/gm)).toEqual(['# Ouverture']);
      expect(result.content).toMatch(/^## Références \{\.unnumbered\}$/m);
      expect(result.content).toContain('*The Allure of the Archives*');
      // La clé mal tapée : citeproc la signale sur sa sortie d'erreur, l'export la dira.
      expect(result.missing).toEqual(['Dupnt_2020']);
    } finally {
      clock.stop();
    }
  });
});

describe.skipIf(!pandocAvailable() || !xelatexAvailable())('export PDF : les citations', () => {
  function exportArticle(content: string, extra: Partial<ExportOptions> = {}): Promise<PDFExportResult> {
    return pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'article',
      content,
      outputPath: join(project, 'article.pdf'),
      metadata: { title: 'Article', author: 'Autrice' },
      ...extra,
    });
  }

  function exportBook(chapters: Array<[string, string]>, extra: Partial<ExportOptions> = {}): Promise<PDFExportResult> {
    const manifest: Chapter[] = chapters.map(([title, body], i) => {
      const filePath = `chapters/0${i + 1}.md`;
      writeFileSync(join(project, filePath), `# ${title}\n\n${body}\n`);
      return { id: `c${i}`, title, filePath, order: i };
    });
    return pdfExportService.exportToPDF({
      projectPath: project,
      projectType: 'book',
      content: '',
      outputPath: join(project, 'livre.pdf'),
      metadata: { title: 'Livre', author: 'Autrice' },
      bookSettings: { ...DEFAULT_BOOK_SETTINGS, bibliography: 'per-chapter' },
      manuscript: { chapters: manifest },
      bibliographyPath: join(project, 'refs.bib'),
      ...extra,
    });
  }

  it(
    'style intégré : titres en italique, bibliographie titrée dans la langue de l’interface, clé fautive signalée',
    async () => {
      setLanguage('en');
      await bibliographyService.loadFromFile(join(project, 'refs.bib'));

      const result = await exportArticle('Texte [@Farge_2013] et faute [@Dupnt_2020].\n', {
        bibliographyPath: join(project, 'refs.bib'),
        citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'en-US' },
      });

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.unresolvedCitations).toEqual(['Dupnt_2020']);
      if (pdftotextAvailable()) {
        const pdf = join(project, 'article.pdf');
        const text = pdfText(pdf);
        expect(text).toContain('References');
        expect(text).not.toContain('Bibliographie');
        expect(text).not.toContain('Références');
        expect(text).not.toContain('•');
        expect(text).toContain('The Allure of the Archives');
        // Ce que la réserve dit : la clé est restée telle quelle.
        expect(text).toContain('Dupnt_2020');
        // Une seule page, sous le style `plain` de la page de titre : l'en-tête en italique du
        // gabarit n'y est pas, seule la citation peut amener une police italique.
        expect(execFileSync('pdfinfo', [pdf], { encoding: 'utf8', env: toolEnv() })).toMatch(/^Pages:\s+1$/m);
        expect(execFileSync('pdffonts', [pdf], { encoding: 'utf8', env: toolEnv() })).toMatch(/Italic/);
      }
    },
    COMPILE_MS
  );

  it(
    'pandoc avec le style du projet : la bibliographie a son titre, la clé fautive est signalée',
    async () => {
      const result = await exportArticle('Texte [@Farge_2013] et faute [@Dupnt_2020].\n', {
        bibliographyPath: join(project, 'refs.bib'),
        cslPath: join(project, 'chicago.csl'),
      });

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.unresolvedCitations).toEqual(['Dupnt_2020']);
      expect(result.missingCsl).toBeUndefined();
      if (pdftotextAvailable()) {
        const text = pdfText(join(project, 'article.pdf'));
        expect(text).toMatch(/Références\s+Farge, Arlette\./);
      }
    },
    COMPILE_MS
  );

  it(
    'sans bibliographie : les clés restent telles quelles, et l’export le dit',
    async () => {
      const result = await exportArticle('Texte [@Farge_2013], et `[@pasunecle]` en code.\n');

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.unresolvedCitations).toEqual(['Farge_2013']);
      if (pdftotextAvailable()) {
        expect(pdfText(join(project, 'article.pdf'))).toContain('[@Farge_2013]');
      }
    },
    COMPILE_MS
  );

  it(
    'bibliographie par chapitre : un titre sous chaque chapitre, et la clé fautive d’un chapitre signalée',
    async () => {
      const result = await exportBook(
        [
          ['Ouverture', 'Voir [@Farge_2013].'],
          ['Suite', 'Encore [@Farge_2013], et une faute [@Dupnt_2020].'],
        ],
        { cslPath: join(project, 'chicago.csl') }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toBeUndefined();
      expect(result.unresolvedCitations).toEqual(['Dupnt_2020']);
      if (pdftotextAvailable()) {
        const text = pdfText(join(project, 'livre.pdf'));
        expect(text).toMatch(/Ouverture[\s\S]*Références[\s\S]*Suite[\s\S]*Références/);
        // La table des matières : chaque « Références » est une section, avec ses points de
        // conduite, sous son chapitre ; pas un chapitre à part, sans retrait ni points (mesuré
        // sans `demoteChapterBibliographyHeading` : 11 pages au lieu de 7).
        const layout = execFileSync('pdftotext', ['-layout', join(project, 'livre.pdf'), '-'], {
          encoding: 'utf8',
          env: toolEnv(),
        });
        expect(layout.match(/^\s+Références(?: \.){3,}/gm)).toHaveLength(2);
        expect(layout).not.toMatch(/^Références\s+\d+\s*$/m);
      }
    },
    COMPILE_MS
  );

  /**
   * Un chapitre où citeproc échoue est déjà nommé (`export.chapterCitationsNotResolved`) : ses
   * clés ne reparaissent pas dans `unresolvedCitations`, qui dirait une autre cause, fausse
   * (« introuvables dans la bibliographie »).
   */
  it(
    'citeproc échoue sur un chapitre : le chapitre est nommé, ses clés ne sont pas dites introuvables',
    async () => {
      writeFileSync(join(project, 'casse.csl'), '<style>tronqué');

      const result = await exportBook(
        [['Ouverture', 'Voir [@Farge_2013] et [@Dupnt_2020].']],
        { cslPath: join(project, 'casse.csl') }
      );

      expect(result, result.error).toMatchObject({ success: true });
      expect(result.warnings).toEqual([
        { code: 'export.chapterCitationsNotResolved', params: { title: 'Ouverture', file: 'chapters/01.md' } },
      ]);
      expect(result.unresolvedCitations).toBeUndefined();
    },
    COMPILE_MS
  );
});
