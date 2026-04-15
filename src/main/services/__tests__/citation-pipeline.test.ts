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
