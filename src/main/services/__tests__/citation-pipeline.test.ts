import { describe, it, expect } from 'vitest';
import { processMarkdownCitations } from '../citation-pipeline';
import type { Citation } from '../../../../backend/types/citation';

function makeCitation(overrides: Partial<Citation>): Citation {
  // Minimal fake — skip getters we don't read in the pipeline.
  return {
    id: 'alice2020',
    type: 'book',
    author: 'Alice, Aline',
    year: '2020',
    title: 'Histoire exemplaire',
    publisher: 'Presses imaginaires',
    ...overrides,
  } as Citation;
}

const resolveMap = (items: Record<string, Citation>) => (key: string) => items[key];

describe('processMarkdownCitations', () => {
  it('is a no-op when no markers are present', async () => {
    const src = 'Un paragraphe sans citation.';
    const res = await processMarkdownCitations(src, { resolve: () => undefined });
    expect(res.md).toBe(src);
    expect(res.footnotes).toHaveLength(0);
    expect(res.bibliography).toHaveLength(0);
    expect(res.missingKeys).toHaveLength(0);
  });

  it('resolves a single [@key] into a numbered footnote + bibliography entry', async () => {
    const cit = makeCitation({ id: 'alice2020' });
    const src = 'Selon Alice [@alice2020], c\'est établi.';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
      locale: 'fr-FR',
    });
    expect(res.md).toContain('[^1]');
    expect(res.md).not.toContain('[@alice2020]');
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].n).toBe(1);
    expect(res.footnotes[0].keys).toEqual(['alice2020']);
    expect(res.footnotes[0].text.length).toBeGreaterThan(0);
    expect(res.bibliography.length).toBeGreaterThan(0);
    expect(res.missingKeys).toHaveLength(0);
  });

  it('leaves the marker intact and reports missing keys', async () => {
    const src = 'Mystère [@ghost1999].';
    const res = await processMarkdownCitations(src, { resolve: () => undefined });
    expect(res.md).toBe(src);
    expect(res.footnotes).toHaveLength(0);
    expect(res.missingKeys).toEqual(['ghost1999']);
  });

  it('supports cluster syntax [@a; @b] as a single footnote', async () => {
    const a = makeCitation({ id: 'alice2020' });
    const b = makeCitation({ id: 'bob2021', author: 'Bob, Bernard', year: '2021', title: 'Autre livre' });
    const src = 'Voir [@alice2020; @bob2021] pour le détail.';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: a, bob2021: b }),
      locale: 'fr-FR',
    });
    expect(res.md).toContain('[^1]');
    expect(res.md).not.toContain('[^2]');
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].keys).toEqual(['alice2020', 'bob2021']);
    // Bibliography should dedupe and include both.
    expect(res.bibliography.length).toBe(2);
  });
});

/**
 * Régression : les notes générées écrasaient les notes manuelles.
 *
 * La numérotation partait de 1 sans regarder le document. Un `[^1]` écrit
 * par l'auteur et la première citation portaient donc le même numéro : deux
 * appels pour une seule définition, et le texte de l'auteur disparaissait du
 * document exporté (pandoc retient la dernière définition).
 */
describe('numérotation des notes générées', () => {
  const cit = makeCitation({ id: 'alice2020' });

  it('démarre après la dernière note manuelle', async () => {
    const src =
      'Note de l’auteur[^1] puis citation [@alice2020].\n\n[^1]: MA NOTE.\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(2);
    expect(res.md).toContain('Note de l’auteur[^1]');
    expect(res.md).toContain('citation [^2]');
    // La définition manuelle est intacte et reste seule sur son numéro.
    expect(res.md).toContain('[^1]: MA NOTE.');
    expect((res.md.match(/\[\^1\]/g) ?? []).length).toBe(2); // appel + définition
  });

  it('tient compte du plus grand numéro, pas du nombre de notes', async () => {
    const src = 'Un[^7] et deux[^3].\n\n[^7]: A.\n[^3]: B.\n\nCitation [@alice2020].';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(8);
  });

  it('ignore les notes des blocs de code (parse Lezer, pas regex)', async () => {
    const src = 'Texte [@alice2020].\n\n```md\n[^99]: pas une note\n```\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit }),
    });
    expect(res.footnotes[0].n).toBe(1);
  });

  it('numérote plusieurs citations à la suite sans collision', async () => {
    const bob = makeCitation({ id: 'bob2021', author: 'Bob, B' });
    const src = 'Note[^1]. Une [@alice2020] et deux [@bob2021].\n\n[^1]: X.\n';
    const res = await processMarkdownCitations(src, {
      resolve: resolveMap({ alice2020: cit, bob2021: bob }),
    });
    expect(res.footnotes.map((f) => f.n)).toEqual([2, 3]);
  });
});
