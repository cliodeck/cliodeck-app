import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectFootnotes,
  prefixFootnoteLabels,
  nextFootnoteNumber,
  renumberFootnotes,
} from '../footnote-tools';

const CORPUS = fileURLToPath(new URL('../../../test-fixtures/editor/', import.meta.url));
const kitchenSink = readFileSync(path.join(CORPUS, 'kitchen-sink.md'), 'utf-8');

describe('nextFootnoteNumber', () => {
  it('ignore les [^99] des blocs de code (bug de la regex historique)', () => {
    // kitchen-sink contient [^1]..[^4] réels et un [^99] dans un bloc de
    // code : le prochain numéro est 5, pas 100.
    expect(nextFootnoteNumber(kitchenSink)).toBe(5);
  });

  it('répond 1 sur un document sans note', () => {
    expect(nextFootnoteNumber('Rien à voir ici.')).toBe(1);
  });

  it('ignore les identifiants libres', () => {
    expect(nextFootnoteNumber('Un[^lester-danzig].\n\n[^lester-danzig]: n.')).toBe(1);
  });
});

describe('renumberFootnotes', () => {
  it('renumérote dans l’ordre d’apparition des appels', () => {
    const doc = 'A[^3] puis B[^1].\n\n[^3]: trois.\n[^1]: un.\n';
    const result = renumberFootnotes(doc);
    expect(result.changed).toBe(true);
    expect(result.content).toBe('A[^1] puis B[^2].\n\n[^1]: trois.\n[^2]: un.\n');
  });

  it('est idempotente et signale changed=false', () => {
    const doc = 'A[^1] et B[^2].\n\n[^1]: un.\n[^2]: deux.\n';
    const result = renumberFootnotes(doc);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(doc);
  });

  it('laisse les identifiants libres intacts et ignore le code', () => {
    const doc =
      'X[^2] et Y[^lester].\n\n```\n[^9]: pas une note\n```\n\n[^2]: deux.\n[^lester]: libre.\n';
    const result = renumberFootnotes(doc);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('X[^1]');
    expect(result.content).toContain('Y[^lester]');
    expect(result.content).toContain('[^9]: pas une note'); // intact
    expect(result.content).toContain('[^lester]: libre.');
  });

  it('préserve le reste du document octet pour octet', () => {
    const doc = 'Avant[^2]  \nmixte\r\nnon-ascii œü[^1]\n\n[^2]: a.\n[^1]: b.';
    const result = renumberFootnotes(doc);
    // En dehors des labels, chaque octet est préservé (espaces de fin,
    // CRLF résiduel, absence de saut final).
    expect(result.content).toBe('Avant[^1]  \nmixte\r\nnon-ascii œü[^2]\n\n[^1]: a.\n[^2]: b.');
  });

  it('numérote les définitions orphelines en queue', () => {
    const doc = 'Appel[^5].\n\n[^5]: cinq.\n[^2]: orpheline.\n';
    const result = renumberFootnotes(doc);
    expect(result.content).toBe('Appel[^1].\n\n[^1]: cinq.\n[^2]: orpheline.\n');
  });
});

describe('collectFootnotes', () => {
  it('distingue appels et définitions', () => {
    const occ = collectFootnotes('A[^1].\n\n[^1]: def.\n');
    expect(occ.map((o) => o.kind)).toEqual(['reference', 'definition']);
    expect(occ.map((o) => o.label)).toEqual(['1', '1']);
  });

  /**
   * Régression : un `[^1]` dans un bloc HTML était invisible.
   *
   * Lezer traite un `HTMLBlock` comme opaque ; pandoc, lui, y voit très
   * bien les notes — vérifié à la main, un `[^1]` dans un `<div>` rend un
   * `\footnote`. Le préfixage par chapitre renommait donc la DÉFINITION
   * sans toucher à l'APPEL resté dans l'encadré : les deux devenaient
   * orphelins et le texte de la note disparaissait du livre exporté.
   */
  it('voit les appels à l’intérieur d’un bloc HTML', () => {
    const doc = '<div class="encadre">\nTexte[^1] ici.\n</div>\n\n[^1]: note.\n';
    const occ = collectFootnotes(doc);

    expect(occ.map((o) => o.kind)).toEqual(['reference', 'definition']);
    expect(occ.map((o) => o.label)).toEqual(['1', '1']);
  });

  it('rend les occurrences dans l’ordre du document', () => {
    // Les appels d'un bloc HTML sont trouvés à la visite du bloc, pas à
    // leur position : sans tri, l'ordre serait faux.
    const doc = 'Avant[^a].\n\n<div>\nDedans[^b].\n</div>\n\nAprès[^c].\n';
    const occ = collectFootnotes(doc);

    expect(occ.map((o) => o.label)).toEqual(['a', 'b', 'c']);
    expect(occ.map((o) => o.from)).toEqual([...occ.map((o) => o.from)].sort((x, y) => x - y));
  });

  it('ne prend pas une définition pour un appel dans un bloc HTML', () => {
    const doc = '<div>\n[^1]: ceci ressemble à une définition\n</div>\n';
    const occ = collectFootnotes(doc);

    expect(occ).toEqual([]);
  });
});

describe('prefixFootnoteLabels — blocs HTML', () => {
  it('préfixe appel ET définition, y compris dans un encadré', () => {
    const doc = '<div class="encadre">\nTexte[^1] ici.\n</div>\n\n[^1]: note.\n';

    const out = prefixFootnoteLabels(doc, 'ch1');

    // Les deux moitiés portent le même label : la note survit à l'assemblage.
    expect(out).toContain('[^ch1-1] ici.');
    expect(out).toContain('[^ch1-1]: note.');
    expect(out).not.toContain('[^1]');
  });
});
