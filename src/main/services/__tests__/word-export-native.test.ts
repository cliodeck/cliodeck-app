import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PizZip from 'pizzip';
import {
  WordExportService,
  splitAbstract,
  pandocUnresolvedCitations,
} from '../word-export';
import { bibliographyService } from '../bibliography-service';
import { CitationEngine, defaultCSLResourcesRoot } from '../../../../backend/core/citation/CitationEngine';

vi.setConfig({ testTimeout: 60_000 });

/**
 * Régression (export Word d'un article réel, 2026-10-02) : le générateur
 * docx interne laissait du markdown littéral dans les notes, le résumé et
 * les citations en retrait, et les clés de citation restaient des clés.
 *
 * On génère un vrai .docx par le chemin interne (pandoc déclaré absent) et
 * on lit son XML : c'est le document que l'auteur ouvre qui fait foi.
 */
let dir: string;

/** Texte seul d'une partie du docx, balises retirées. */
const plain = (xml: string): string => xml.replace(/<[^>]+>/g, '');

async function exportNative(
  content: string,
  extra: { abstract?: string; citation?: { useEngine: boolean; style?: string; locale?: string } } = {}
): Promise<{ document: string; footnotes: string; rels: string; unresolved?: string[] }> {
  const projectPath = mkdtempSync(join(dir, 'projet-'));
  if (extra.abstract) writeFileSync(join(projectPath, 'abstract.md'), extra.abstract);
  const service = new WordExportService();
  vi.spyOn(
    service as unknown as { checkPandoc: () => Promise<boolean> },
    'checkPandoc'
  ).mockResolvedValue(false);
  const outputPath = join(projectPath, 'sortie.docx');
  const result = await service.exportToWord({
    projectPath,
    projectType: 'article',
    content,
    outputPath,
    metadata: { title: 'Titre', author: 'Autrice' },
    citation: extra.citation,
  });
  expect(result.success).toBe(true);
  const zip = new PizZip(readFileSync(outputPath));
  const read = (name: string): string => zip.file(name)?.asText() ?? '';
  return {
    document: read('word/document.xml'),
    footnotes: read('word/footnotes.xml'),
    rels: read('word/_rels/footnotes.xml.rels') + read('word/_rels/document.xml.rels'),
    unresolved: result.unresolvedCitations,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliodeck-word-native-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('générateur docx interne : markdown en ligne', () => {
  it('interprète le markdown des notes de bas de page', async () => {
    const { footnotes, rels } = await exportNative(
      'Texte[^a].\n\n[^a]: Voir *La Méditerranée* et [le site](https://tropy.org/).\n'
    );
    const text = plain(footnotes);
    expect(text).toContain('Voir La Méditerranée et le site.');
    expect(text).not.toContain('*');
    expect(text).not.toContain('](');
    expect(footnotes).toMatch(/<w:i\/>.*La Méditerranée/s);
    expect(rels).toContain('https://tropy.org/');
  });

  it('ne prend pas le tiret bas d’une clé pour un début d’italique', async () => {
    const { document } = await exportNative(
      'Srnicek [@Srnicek_2025] décrit les tactiques d’un _braconneur_. Fin.\n'
    );
    expect(plain(document)).toContain('Srnicek [@Srnicek_2025] décrit les tactiques d’un braconneur. Fin.');
  });

  it('retire l’antislash d’un caractère échappé', async () => {
    const { document } = await exportNative('Elle écrit : « \\[...] un terme de marketing ».\n');
    expect(plain(document)).toContain('« [...] un terme');
    expect(plain(document)).not.toContain('\\');
  });

  it('garde gras et liens dans une citation en retrait', async () => {
    const { document, rels } = await exportNative(
      '> **Avertissement :** écrit avec [ClioDeck](https://cliodeck.app).\n'
    );
    expect(plain(document)).toContain('Avertissement : écrit avec ClioDeck.');
    expect(document).toMatch(/<w:b\/>.*Avertissement/s);
    expect(rels).toContain('https://cliodeck.app');
  });

  it('retire le titre du résumé quelle que soit la langue, et le reprend', async () => {
    const { document } = await exportNative('Corps.\n', {
      abstract: '# Abstract\n\nUn *résumé* soigné.\n',
    });
    const text = plain(document);
    expect(text).toContain('Abstract');
    expect(text).toContain('Un résumé soigné.');
    expect(text).not.toContain('#');
    expect(text).not.toContain('Résumé');
  });
});

describe('générateur docx interne : citations par le moteur', () => {
  beforeAll(async () => {
    await bibliographyService.parseContent(
      '@book{Farge_2013,\n  author = {Farge, Arlette},\n  title = {The Allure of the Archives},\n  publisher = {Yale University Press},\n  year = {2013}\n}\n'
    );
  });

  it('remplace les clés, y compris dans une note de l’auteur et sous forme nue', async () => {
    const { document, footnotes, unresolved } = await exportNative(
      'Le monde de Farge[^f], repris par @Farge_2013, et encore [@Farge_2013].\n\n' +
        '[^f]: [@Farge_2013]. Paru en 1989.\n',
      { citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'en-US' } }
    );
    const all = plain(document) + plain(footnotes);
    expect(all).not.toContain('@Farge_2013');
    expect(unresolved).toBeUndefined();
    expect(plain(footnotes)).toContain('The Allure of the Archives');
    expect(footnotes).toMatch(/<w:i\/>.*The Allure of the Archives/s);
    // Pas de note dans la note : aucun appel littéral.
    expect(plain(footnotes)).not.toMatch(/\[\^\d+\]/);
    expect(plain(document)).toContain('repris par Farge,');
  });

  it('signale les clés introuvables au lieu de réussir en silence', async () => {
    const { unresolved } = await exportNative('Mystère [@Fantome_1999].\n', {
      citation: { useEngine: true, style: 'chicago-note-bibliography', locale: 'en-US' },
    });
    expect(unresolved).toEqual(['Fantome_1999']);
  });
});

describe('résumé et diagnostics', () => {
  it('splitAbstract sépare titre et texte', () => {
    expect(splitAbstract('# Résumé\n\nTexte.')).toEqual({ heading: 'Résumé', body: 'Texte.' });
    expect(splitAbstract('## Zusammenfassung ##\nText.')).toEqual({
      heading: 'Zusammenfassung',
      body: 'Text.',
    });
    expect(splitAbstract('Texte sans titre.\n')).toEqual({ body: 'Texte sans titre.' });
  });

  it('pandocUnresolvedCitations lit les avertissements de citeproc', () => {
    const stderr =
      '[WARNING] Citeproc: citation Fantome_1999 not found\n' +
      '[WARNING] Citeproc: citation Fantome_1999 not found\n' +
      '[WARNING] Citeproc: citation autre:2020 not found\n';
    expect(pandocUnresolvedCitations(stderr)).toEqual(['Fantome_1999', 'autre:2020']);
  });
});

/**
 * Cause première du bug : le moteur cherchait ses styles à un chemin relatif
 * qui n'existe que depuis les sources. Dans l'app construite, aucun style
 * n'était trouvé et toutes les citations étaient comptées introuvables.
 */
describe('emplacement des styles CSL', () => {
  it('le dossier par défaut existe et contient les styles proposés', () => {
    const root = defaultCSLResourcesRoot();
    expect(existsSync(join(root, 'chicago-note-bibliography.csl'))).toBe(true);
    expect(new CitationEngine().stylePath('chicago-note-bibliography')).toBeDefined();
    expect(new CitationEngine().stylePath('style-inexistant')).toBeUndefined();
  });

  it('distingue un style à notes d’un style auteur-date', () => {
    const engine = new CitationEngine();
    expect(engine.isNoteStyle('chicago-note-bibliography')).toBe(true);
    expect(engine.isNoteStyle('modern-language-association')).toBe(false);
  });
});
