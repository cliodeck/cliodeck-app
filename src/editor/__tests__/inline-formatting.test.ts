import { describe, expect, it } from 'vitest';
import {
  computeInlineToggle,
  INLINE_MARKS,
} from '../cm/inline-formatting';

const BOLD = INLINE_MARKS.bold.markers;
const ITALIC = INLINE_MARKS.italic.markers;

/** Applique le résultat au document pour vérifier le texte final. */
function apply(doc: string, from: number, to: number, markers: readonly string[], ph: string) {
  const r = computeInlineToggle(doc, from, to, markers, ph);
  const out = doc.slice(0, r.from) + r.insert + doc.slice(r.to);
  return { out, sel: out.slice(r.selFrom, r.selTo), r };
}

describe('computeInlineToggle — régression #10 (la sélection était écrasée)', () => {
  it('entoure la sélection au lieu de la remplacer', () => {
    const doc = 'un mot important';
    const { out, sel } = apply(doc, 3, 6, BOLD, 'x');
    expect(out).toBe('un **mot** important');
    expect(sel).toBe('mot');
  });

  it('retire les marques quand la sélection est déjà entourée (toggle off)', () => {
    const doc = 'un **mot** important';
    // « mot » sélectionné entre les marques
    const { out, sel } = apply(doc, 5, 8, BOLD, 'x');
    expect(out).toBe('un mot important');
    expect(sel).toBe('mot');
  });

  it('retire les marques quand la sélection les inclut', () => {
    const doc = 'un **mot** important';
    const { out, sel } = apply(doc, 3, 10, BOLD, 'x');
    expect(out).toBe('un mot important');
    expect(sel).toBe('mot');
  });

  it("reconnaît l'alias __ au unwrap mais écrit ** au wrap", () => {
    const inc = apply('du __gras__ ici', 3, 11, BOLD, 'x');
    expect(inc.out).toBe('du gras ici');

    const wrap = apply('du gras ici', 3, 7, BOLD, 'x');
    expect(wrap.out).toBe('du **gras** ici');
  });

  it('sélection vide : insère les marques avec le placeholder sélectionné', () => {
    const { out, sel } = apply('début ', 6, 6, BOLD, 'texte en gras');
    expect(out).toBe('début **texte en gras**');
    expect(sel).toBe('texte en gras');
  });

  it("l'italique dans du gras s'imbrique sans amputer la paire **", () => {
    const doc = 'un **mot** important';
    // « mot » sélectionné : entouré de « * » côté doc, mais ce sont les
    // moitiés d'une paire ** — l'italique doit imbriquer, pas amputer.
    const { out } = apply(doc, 5, 8, ITALIC, 'x');
    expect(out).toBe('un **_mot_** important');
  });

  it("l'italique se retire proprement (_mot_ sélectionné avec marques)", () => {
    const { out, sel } = apply('en _italique_ ici', 3, 13, ITALIC, 'x');
    expect(out).toBe('en italique ici');
    expect(sel).toBe('italique');
  });

  it('en début de document, pas de lecture hors bornes', () => {
    const { out } = apply('mot', 0, 3, BOLD, 'x');
    expect(out).toBe('**mot**');
  });
});
