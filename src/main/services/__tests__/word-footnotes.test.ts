import { describe, it, expect } from 'vitest';
import { extractManualFootnotes } from '../word-footnotes';

describe('extractManualFootnotes', () => {
  it('retire la définition du corps et remplace l’appel', () => {
    const src = 'Un texte[^1].\n\n[^1]: La note.\n';
    const res = extractManualFootnotes(src);
    expect(res.markdown).toContain('Un texte{{FN:1}}.');
    expect(res.markdown).not.toContain('[^1]: La note.');
    expect(res.footnotes).toEqual([{ label: '1', id: 1, text: 'La note.' }]);
  });

  it('conserve le numéro de l’auteur quand il est libre', () => {
    const src = 'A[^7] et B[^3].\n\n[^7]: Sept.\n[^3]: Trois.\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes.map((f) => [f.label, f.id])).toEqual([
      ['3', 3],
      ['7', 7],
    ]);
    expect(res.markdown).toContain('A{{FN:7}} et B{{FN:3}}');
  });

  it('n’entre jamais en collision avec les notes du moteur', () => {
    const src = 'Note[^1].\n\n[^1]: Manuelle.\n';
    const res = extractManualFootnotes(src, [1, 2]);
    expect(res.footnotes[0].id).toBe(3);
    expect(res.markdown).toContain('{{FN:3}}');
  });

  it('gère les étiquettes libres', () => {
    const src = 'Voir[^lester-danzig].\n\n[^lester-danzig]: Lester, 1932.\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes[0]).toMatchObject({ label: 'lester-danzig', text: 'Lester, 1932.' });
    expect(res.markdown).toContain(`{{FN:${res.footnotes[0].id}}}`);
  });

  it('recolle les continuations indentées', () => {
    const src = 'X[^1].\n\n[^1]: Début\n    suite de la note.\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes[0].text).toBe('Début suite de la note.');
  });

  it('ignore les notes des blocs de code (arbre Lezer)', () => {
    const src = 'Texte normal.\n\n```md\n[^99]: pas une note\n```\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes).toHaveLength(0);
    expect(res.markdown).toContain('[^99]: pas une note');
  });

  it('laisse le document intact quand il n’y a aucune note', () => {
    const src = '# Titre\n\nDu texte.\n';
    expect(extractManualFootnotes(src)).toEqual({ markdown: src, footnotes: [] });
  });

  it('garde une définition jamais appelée', () => {
    const src = 'Rien ici.\n\n[^orpheline]: Texte perdu.\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].text).toBe('Texte perdu.');
  });
});
