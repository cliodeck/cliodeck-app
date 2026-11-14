import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import { splitIntoChapters, WordExportService } from '../word-export';
import { bibliographyService } from '../bibliography-service';
import { setLanguage } from '../../i18n';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Découpage d'un manuscrit assemblé en sections docx (une par chapitre).
 * La structure docx elle-même est vérifiée par le script d'inspection du
 * .docx produit (voir le rapport de Phase 4) ; ici on verrouille la règle
 * de découpage, qui est la partie sujette aux régressions.
 */
describe('splitIntoChapters', () => {
  it('coupe à chaque titre de niveau 1', () => {
    const md = '# Un\n\nTexte un.\n\n# Deux\n\nTexte deux.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('# Un');
    expect(chunks[0]).not.toContain('# Deux');
    expect(chunks[1]).toContain('# Deux');
  });

  it('ne coupe pas sur les titres de niveau inférieur', () => {
    const md = '# Un\n\n## Section\n\nTexte.\n\n### Sous-section\n\nSuite.\n';
    expect(splitIntoChapters(md)).toHaveLength(1);
  });

  it('ignore un # dans un bloc de code (arbre Lezer, pas regex)', () => {
    const md = '# Un\n\n```md\n# pas un chapitre\n```\n\nSuite.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('# pas un chapitre');
  });

  it('garde ce qui précède le premier titre', () => {
    const md = 'Dédicace sans titre.\n\n# Un\n\nTexte.\n';
    const chunks = splitIntoChapters(md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('Dédicace sans titre.');
  });

  it('rend le document intact quand il n’a aucun titre', () => {
    // Aucun découpage possible : le document est rendu tel quel, sans
    // rognage — c'est un chemin de sortie, pas un nettoyage.
    const md = 'Juste du texte.\n';
    expect(splitIntoChapters(md)).toEqual([md]);
  });
});

/**
 * S12-1-23 : sans pandoc, la bibliographie du moteur était ajoutée à la liste des paragraphes de
 * l'article, mais un livre construit ses sections chapitre par chapitre, sans elle. Les appels de
 * note sortaient, la bibliographie se perdait sans un mot.
 */
describe('livre, moteur de citations, pandoc absent : la bibliographie', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cliodeck-word-book-'));
    setLanguage('fr');
    await bibliographyService.parseContent(
      '@book{Farge_2013,\n  author = {Farge, Arlette},\n  title = {The Allure of the Archives},\n' +
        '  publisher = {Yale University Press},\n  year = {2013}\n}\n'
    );
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Exporte un livre de deux chapitres par le générateur interne ; rend `document.xml`. */
  async function exportBook(firstChapter: string): Promise<string> {
    const projectPath = mkdtempSync(join(dir, 'livre-'));
    mkdirSync(join(projectPath, 'chapters'));
    writeFileSync(join(projectPath, 'chapters', '01.md'), firstChapter);
    writeFileSync(join(projectPath, 'chapters', '02.md'), '# Second\n\nDERNIERCHAPITRE.\n');
    const service = new WordExportService();
    vi.spyOn(
      service as unknown as { checkPandoc: () => Promise<boolean> },
      'checkPandoc'
    ).mockResolvedValue(false);
    const outputPath = join(projectPath, 'livre.docx');
    const result = await service.exportToWord({
      projectPath,
      projectType: 'book',
      content: '',
      outputPath,
      metadata: { title: 'Livre' },
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'fr-FR' },
      manuscript: {
        chapters: [
          { id: 'a', title: 'Premier', filePath: 'chapters/01.md', order: 0 },
          { id: 'b', title: 'Second', filePath: 'chapters/02.md', order: 1 },
        ],
      },
    });
    expect(result, result.error).toMatchObject({ success: true });
    return new PizZip(readFileSync(outputPath)).file('word/document.xml')?.asText() ?? '';
  }

  const plain = (xml: string): string => xml.replace(/<[^>]+>/g, '');

  /** Le paragraphe docx qui contient `text`. */
  const paragraphOf = (document: string, text: string): string =>
    document.split('</w:p>').find((p) => plain(p).includes(text)) ?? '';

  it('« Références » et l’entrée Yale en fin d’ouvrage, au premier niveau de titre', async () => {
    const document = await exportBook('# Premier\n\nTexte [@Farge_2013].\n');
    const text = plain(document);

    expect(text).toContain('Références');
    expect(text).toContain('Yale University Press');
    expect(text.indexOf('Références')).toBeGreaterThan(text.indexOf('DERNIERCHAPITRE'));
    // Titre de niveau 1 : la table des matières du livre (niveaux 1 à 3) le reprend.
    expect(paragraphOf(document, 'Références')).toContain('<w:pStyle w:val="Heading1"/>');
  });

  it('le `reference-section-title` du front matter nomme la section', async () => {
    const document = await exportBook(
      '---\nreference-section-title: Sources\n---\n\n# Premier\n\nTexte [@Farge_2013].\n'
    );
    const text = plain(document);

    expect(paragraphOf(document, 'Sources')).toContain('<w:pStyle w:val="Heading1"/>');
    expect(text).toContain('Yale University Press');
    expect(text).not.toContain('Références');
  });
});
