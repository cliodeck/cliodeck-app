import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeDocumentStats } from '../document-stats';

const CORPUS_DIR = fileURLToPath(
  new URL('../../../test-fixtures/editor/', import.meta.url)
);
const fixture = (name: string): string =>
  readFileSync(path.join(CORPUS_DIR, name), 'utf-8');

describe('computeDocumentStats (comptages par arbre Lezer)', () => {
  it('kitchen-sink : 4 notes (le [^99] du bloc de code est ignoré), 6 clés de citation', () => {
    const s = computeDocumentStats(fixture('kitchen-sink.md'));
    // La regex historique donnait 100 notes possibles ([^99] dans le code
    // comptait) — le parse Lezer donne les 4 vraies paires réf/déf.
    expect(s.footnotes).toBe(4);
    // 6 clés : [@lester1932, p. 12] (coupée par un retour à la ligne),
    // le cluster [@lester1932; @clavert2013], [@schmidt1988] en table,
    // [@clavert2013] en quote, [@lester1932] en tâche. Le code exclu.
    expect(s.citations).toBe(6);
    expect(s.paragraphs).toBeGreaterThan(0);
    expect(s.words).toBeGreaterThan(50);
  });

  it('footnotes.md : 5 paires distinctes, identifiants libres compris', () => {
    const s = computeDocumentStats(fixture('footnotes.md'));
    expect(s.footnotes).toBe(5); // [^1..4] + [^lester-danzig]
  });

  it('citations.md : 13 clés, aucune note', () => {
    const s = computeDocumentStats(fixture('citations.md'));
    expect(s.citations).toBe(13);
    expect(s.footnotes).toBe(0);
  });

  it('exclut citations et notes des blocs de code', () => {
    const s = computeDocumentStats(
      'texte [@vrai] ici et [@a; @b, p. 3]\n\n```\n[@faux] [^9]\n```\n'
    );
    expect(s.citations).toBe(3); // vrai, a, b — pas faux
    expect(s.footnotes).toBe(0); // [^9] dans le code n'existe pas
  });

  it('un appel sans définition (ou l’inverse) n’est pas une note complète', () => {
    expect(computeDocumentStats('Un appel[^1] sans définition.').footnotes).toBe(0);
    expect(computeDocumentStats('[^orpheline]: définition seule.').footnotes).toBe(0);
    expect(
      computeDocumentStats('Appel[^a] ici.\n\n[^a]: et sa définition.').footnotes
    ).toBe(1);
  });

  it('le texte hors syntaxe exclut marqueurs, URLs et code', () => {
    const s = computeDocumentStats('# Titre\n\nDu **gras** et un [lien](https://tres-longue-url.example.org/xyz).\n');
    // « Titre Du gras et un lien. » → 6 mots ; ni #, ni **, ni l'URL.
    expect(s.words).toBe(6);
    expect(s.chars).toBe('TitreDugrasetunlien.'.length);
  });

  it('document vide → tout à zéro', () => {
    expect(computeDocumentStats('')).toEqual({
      words: 0,
      chars: 0,
      charsWithSpaces: 0,
      paragraphs: 0,
      citations: 0,
      footnotes: 0,
    });
  });
});
