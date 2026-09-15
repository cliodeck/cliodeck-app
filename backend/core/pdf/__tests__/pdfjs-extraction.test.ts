/**
 * Extraction réelle d'un PDF par pdfjs-dist, sans simulation.
 *
 * `fixtures/extraction-fixture.pdf` est produit par XeLaTeX depuis
 * `fixtures/extraction-fixture.tex` (source versionnée à côté). Il réunit ce
 * qui casse une extraction sans bruit : ligatures (« efficacité », « fichiers »),
 * diacritiques et guillemets français, grec polytonique, tiret demi-cadratin,
 * note de bas de page, deux pages, métadonnées XMP/Info.
 *
 * Garde-fou de la montée pdfjs 3 → 5 (#77) : le chemin d'extraction est celui
 * par lequel entre tout PDF indexé, et une régression y est silencieuse — le
 * texte est juste moins bon. Pour un contrôle plus large sur de vrais PDF,
 * `scripts/pdf-extraction-snapshot.mjs` compare deux instantanés.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFExtractor } from '../PDFExtractor';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'extraction-fixture.pdf',
);

describe('PDFExtractor — extraction réelle (pdfjs-dist)', () => {
  const extractor = new PDFExtractor();

  it('lit les deux pages, dans l’ordre', async () => {
    const { pages } = await extractor.extractDocument(fixture);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    expect(pages[1].text).toContain('seconde page');
  });

  it('rend les ligatures, les diacritiques et la typographie française en texte', async () => {
    const { pages } = await extractor.extractDocument(fixture);
    const text = pages[0].text;
    for (const expected of [
      'efficacité',
      'fichiers officiels',
      'œuvre',
      'cœur',
      'naïveté',
      'Ærø',
      '1914–1918',
      '«',
      '»',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('garde le grec polytonique', async () => {
    const { pages } = await extractor.extractDocument(fixture);
    expect(pages[0].text).toContain('Ἱστορίης');
  });

  it('extrait la note de bas de page avec la page qui la porte', async () => {
    const { pages } = await extractor.extractDocument(fixture);
    expect(pages[0].text).toContain('F/17/1234');
    expect(pages[1].text).not.toContain('F/17/1234');
  });

  it('lit le titre, les mots-clés et l’auteur dans les métadonnées', async () => {
    const { title, metadata } = await extractor.extractDocument(fixture);
    expect(title).toBe('Histoire des archives numériques');
    expect(metadata.keywords).toEqual(['archives', 'extraction', 'pdfjs']);
    expect(await extractor.extractAuthor(fixture)).toBe('ClioDeck Fixture');
    expect(await extractor.getPageCount(fixture)).toBe(2);
  });

  it('renvoie le texte d’une page isolée et refuse un numéro hors limites', async () => {
    expect(await extractor.extractText(fixture, 2)).toContain('seconde page');
    await expect(extractor.extractText(fixture, 3)).rejects.toThrow();
  });
});
