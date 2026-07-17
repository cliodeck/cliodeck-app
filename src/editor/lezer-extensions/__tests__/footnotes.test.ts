import { describe, expect, it } from 'vitest';
import { nodes, texts } from './helpers';

describe('FootnoteReference (inline)', () => {
  it('parses a numeric reference with exact positions', () => {
    const doc = 'Un appel[^1] simple.';
    const [ref] = nodes(doc, 'FootnoteReference');
    expect(ref).toMatchObject({ from: 8, to: 12, text: '[^1]' });
    expect(texts(doc, 'FootnoteLabel')).toEqual(['1']);
    expect(texts(doc, 'FootnoteMark')).toEqual(['[^', ']']);
  });

  it('parses free-form and non-ASCII identifiers', () => {
    expect(texts('Voir[^lester-danzig].', 'FootnoteLabel')).toEqual([
      'lester-danzig',
    ]);
    expect(texts('Mot[^ü] accentué.', 'FootnoteLabel')).toEqual(['ü']);
  });

  it('rejects empty, spaced or unterminated labels', () => {
    expect(nodes('Rien[^] ici.', 'FootnoteReference')).toHaveLength(0);
    expect(nodes('Rien[^a b] ici.', 'FootnoteReference')).toHaveLength(0);
    expect(nodes('Rien[^abc sans fin.', 'FootnoteReference')).toHaveLength(0);
  });

  it('parses a reference inside a blockquote', () => {
    const doc = '> Une citation avec un appel[^4].';
    expect(texts(doc, 'FootnoteLabel')).toEqual(['4']);
  });

  it('does not parse inside inline code or fenced code', () => {
    expect(nodes('Du `code [^1] inline`.', 'FootnoteReference')).toHaveLength(0);
    expect(
      nodes('```\n[^1] dans du code\n```\n', 'FootnoteReference')
    ).toHaveLength(0);
  });

  it('multiple references stacked in one sentence', () => {
    const doc = 'Un[^1], deux[^2], trois[^3].';
    expect(texts(doc, 'FootnoteLabel')).toEqual(['1', '2', '3']);
  });
});

describe('FootnoteDefinition (block)', () => {
  it('parses a one-line definition with label markers', () => {
    const doc = '[^1]: Première note, une seule ligne.\n';
    const [def] = nodes(doc, 'FootnoteDefinition');
    expect(def.from).toBe(0);
    expect(def.text).toContain('Première note');
    expect(texts(doc, 'FootnoteLabel')).toEqual(['1']);
    expect(texts(doc, 'FootnoteMark')).toEqual(['[^', ']:']);
  });

  it('keeps indented continuations and a second paragraph inside', () => {
    const doc = [
      '[^3]: Troisième note sur',
      '    plusieurs lignes, avec continuation indentée.',
      '',
      '    Et un second paragraphe dans la même note.',
      '',
      'Après.',
      '',
    ].join('\n');
    const defs = nodes(doc, 'FootnoteDefinition');
    expect(defs).toHaveLength(1);
    expect(defs[0].text).toContain('second paragraphe');
    expect(defs[0].text).not.toContain('Après.');
    // The definition holds two child paragraphs.
    const paragraphs = nodes(doc, 'Paragraph').filter(
      (p) => p.from >= defs[0].from && p.to <= defs[0].to
    );
    expect(paragraphs).toHaveLength(2);
  });

  it('an unindented next line closes the definition (new block)', () => {
    const doc = '[^1]: Note courte.\n[^2]: Autre note.\n';
    const defs = nodes(doc, 'FootnoteDefinition');
    expect(defs).toHaveLength(2);
    expect(texts(doc, 'FootnoteLabel')).toEqual(['1', '2']);
  });

  it('parses inline formatting inside the definition body', () => {
    const doc = '[^2]: Deuxième note avec de la *mise en forme* et du `code`.\n';
    const emph = nodes(doc, 'Emphasis');
    expect(emph).toHaveLength(1);
    expect(nodes(doc, 'InlineCode')).toHaveLength(1);
  });

  it('requires the colon — otherwise it is a paragraph with a reference', () => {
    const doc = '[^1] sans deux-points.\n';
    expect(nodes(doc, 'FootnoteDefinition')).toHaveLength(0);
    expect(nodes(doc, 'FootnoteReference')).toHaveLength(1);
  });

  it('does not fire inside fenced code or indented code', () => {
    expect(
      nodes('```\n[^99]: ni une vraie note\n```\n', 'FootnoteDefinition')
    ).toHaveLength(0);
    expect(
      nodes('Para.\n\n    [^1]: code indenté\n', 'FootnoteDefinition')
    ).toHaveLength(0);
  });

  it('free-form identifier definition', () => {
    const doc = '[^lester-danzig]: Note à identifiant libre.\n';
    expect(texts(doc, 'FootnoteLabel')).toEqual(['lester-danzig']);
    expect(nodes(doc, 'FootnoteDefinition')).toHaveLength(1);
  });
});
