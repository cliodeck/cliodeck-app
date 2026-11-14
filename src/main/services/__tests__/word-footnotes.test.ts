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

  /**
   * S12-1-16 : la détection passait par l'arbre Lezer, pas la réécriture. Une regex globale
   * frappait les appels jusque dans le code, et le retrait ligne à ligne ôtait une ligne `[^1]: …`
   * d'un bloc de code, qui écrasait le texte de la vraie note quand elle venait après elle.
   */
  const SYNTAXE =
    'La syntaxe `[^1]` crée une note[^1].\n\n[^1]: Vraie note.\n\n```\n[^1]: exemple de code\n```\n';

  it('laisse intacts le code en ligne et le bloc de code', () => {
    const res = extractManualFootnotes(SYNTAXE);

    expect(res.markdown).toContain('La syntaxe `[^1]` crée une note{{FN:1}}.');
    expect(res.markdown).toContain('```\n[^1]: exemple de code\n```');
    expect(res.markdown).not.toContain('Vraie note.');
  });

  it('la vraie note garde son texte, même suivie d’une ligne `[^1]:` dans un bloc de code', () => {
    expect(extractManualFootnotes(SYNTAXE).footnotes).toEqual([{ label: '1', id: 1, text: 'Vraie note.' }]);
  });

  it('un appel dans un bloc de code n’est pas remplacé', () => {
    const src = 'Texte[^1].\n\n    exemple[^1]\n\n[^1]: Note.\n';
    const res = extractManualFootnotes(src);

    expect(res.markdown).toContain('Texte{{FN:1}}.');
    expect(res.markdown).toContain('    exemple[^1]');
  });

  /**
   * Lezer lit `![^1]` comme un début d'image, pandoc comme « ! » suivi d'un appel (mesuré, pandoc
   * 3.13). L'appel posé après un point d'exclamation, à la française, reste un appel.
   */
  it('un appel après « ! » reste un appel, comme chez pandoc', () => {
    const res = extractManualFootnotes('C’est faux ![^1] dit-il.\n\n[^1]: La note.\n');

    expect(res.markdown).toContain('C’est faux !{{FN:1}} dit-il.');
    expect(res.footnotes).toEqual([{ label: '1', id: 1, text: 'La note.' }]);
  });

  it('un crochet échappé n’est pas un appel, comme chez pandoc', () => {
    const res = extractManualFootnotes('Échappé \\[^1] ici, appel[^1].\n\n[^1]: La note.\n');

    expect(res.markdown).toContain('Échappé \\[^1] ici, appel{{FN:1}}.');
  });

  /** S12-2-6 : les paragraphes d'une note étaient joints par une espace, en un seul. */
  it('garde les paragraphes d’une note, séparés par une ligne vide', () => {
    const src = 'Texte[^1].\n\n[^1]: Premier paragraphe.\n\n    Second paragraphe.\n\nSuite du corps.\n';
    const res = extractManualFootnotes(src);

    expect(res.footnotes[0].text).toBe('Premier paragraphe.\n\nSecond paragraphe.');
    expect(res.markdown).toContain('Texte{{FN:1}}.');
    expect(res.markdown).toContain('Suite du corps.');
    expect(res.markdown).not.toContain('paragraphe.');
  });

  it('la dernière définition d’une étiquette l’emporte, comme chez pandoc', () => {
    const src = 'X[^1].\n\n[^1]: Première.\n\n[^1]: Seconde.\n';
    const res = extractManualFootnotes(src);

    expect(res.footnotes).toEqual([{ label: '1', id: 1, text: 'Seconde.' }]);
    expect(res.markdown).not.toMatch(/Première|Seconde/);
  });

  it('une ligne collée sous une définition, sans retrait, appartient à la note, comme chez pandoc', () => {
    const src = 'X[^1].\n\n[^1]: Ligne un\nligne collée.\n\nCorps.\n';
    const res = extractManualFootnotes(src);

    expect(res.footnotes[0].text).toBe('Ligne un ligne collée.');
    expect(res.markdown).not.toContain('ligne collée');
    expect(res.markdown).toContain('Corps.');
  });

  it('un appel écrit dans une note reste dans son texte, le corps ne le voit pas', () => {
    const src = 'A[^1].\n\n[^1]: Voir aussi[^2].\n\n[^2]: Autre.\n';
    const res = extractManualFootnotes(src);

    expect(res.footnotes.find((f) => f.label === '1')?.text).toBe('Voir aussi[^2].');
    expect(res.markdown.trim()).toBe('A{{FN:1}}.');
  });

  it('garde une définition jamais appelée', () => {
    const src = 'Rien ici.\n\n[^orpheline]: Texte perdu.\n';
    const res = extractManualFootnotes(src);
    expect(res.footnotes).toHaveLength(1);
    expect(res.footnotes[0].text).toBe('Texte perdu.');
  });
});
