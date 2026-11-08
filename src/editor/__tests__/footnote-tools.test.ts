import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pandocAvailable } from '../../../backend/__tests__/helpers/native-guards';
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

/**
 * Une note = une définition, pas une étiquette (BT1-3).
 *
 * L'auteur insère une note à la main entre deux paragraphes et lui donne le
 * numéro de sa place, déjà pris par la note suivante. La correspondance par
 * étiquette laissait tout en l'état (« déjà numérotées ») ; à l'export, pandoc
 * ne garde que la dernière définition d'un numéro et le texte de l'autre note
 * disparaît.
 */
describe('renumberFootnotes — une note par définition', () => {
  /** Le texte de note que porte chaque appel, dans l'ordre du document. */
  const callTexts = (doc: string): string[] => {
    const occ = collectFootnotes(doc);
    const defText = (label: string): string => {
      const def = occ.filter((o) => o.kind === 'definition' && o.label === label);
      // Deux définitions d'un même numéro : l'export n'en garderait qu'une.
      if (def.length !== 1) return `<${def.length} définitions>`;
      return doc.slice(def[0].to + 3).split('\n')[0];
    };
    return occ.filter((o) => o.kind === 'reference').map((o) => defText(o.label));
  };

  it('(a) une définition entre deux paragraphes, séparée par des lignes vides, est renumérotée', () => {
    const doc =
      'Un[^1].\n\nDeux[^4].\n\n[^4]: insérée entre deux paragraphes.\n\nTrois[^2].\n\n[^1]: un.\n[^2]: deux.\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe(
      'Un[^1].\n\nDeux[^2].\n\n[^2]: insérée entre deux paragraphes.\n\nTrois[^3].\n\n[^1]: un.\n[^3]: deux.\n'
    );
  });

  it('(b) un numéro réemployé à la main devient une note distincte, et chaque appel garde son texte', () => {
    const doc =
      'Un[^1].\n\nAjout[^2].\n\n[^2]: ajoutée à la main.\n\nDeux[^2] trois[^3].\n\n' +
      '[^1]: un.\n[^2]: deux.\n[^3]: trois.\n';
    expect(callTexts(doc)).toContain('<2 définitions>');

    const result = renumberFootnotes(doc);

    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      'Un[^1].\n\nAjout[^2].\n\n[^2]: ajoutée à la main.\n\nDeux[^3] trois[^4].\n\n' +
        '[^1]: un.\n[^3]: deux.\n[^4]: trois.\n'
    );
    expect(callTexts(result.content)).toEqual(['un.', 'ajoutée à la main.', 'deux.', 'trois.']);
    expect(result.nextNumber).toBe(5);
    expect(result.unlinked).toEqual([]);
  });

  it('(c) une note sur plusieurs paragraphes garde ses paragraphes, un bloc de code reste intact', () => {
    const doc =
      'Un[^2].\n\n[^2]: Premier paragraphe.\n\n    Second paragraphe de la même note.\n\n' +
      'Deux[^1].\n\n```\n[^7]: pas une note\nNi[^7] ici.\n```\n\n<div>\n[^7]: pas plus ici\n</div>\n\n[^1]: un.\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe(
      'Un[^1].\n\n[^1]: Premier paragraphe.\n\n    Second paragraphe de la même note.\n\n' +
        'Deux[^2].\n\n```\n[^7]: pas une note\nNi[^7] ici.\n```\n\n<div>\n[^7]: pas plus ici\n</div>\n\n[^2]: un.\n'
    );
  });

  it('laisse les étiquettes libres intactes, même entre deux notes de même numéro', () => {
    const doc =
      'Ajout[^1].\n\n[^1]: ajoutée.\n\nUn[^1].\n\nLibre[^2bis].\n\n[^2bis]: libre.\n\n[^1]: un.\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe(
      'Ajout[^1].\n\n[^1]: ajoutée.\n\nUn[^2].\n\nLibre[^2bis].\n\n[^2bis]: libre.\n\n[^2]: un.\n'
    );
  });

  it('est idempotente sur un numéro réemployé', () => {
    const doc =
      'Un[^1].\n\nAjout[^2].\n\n[^2]: ajoutée.\n\nDeux[^2].\n\n[^1]: un.\n[^2]: deux.\n';
    const once = renumberFootnotes(doc);
    const twice = renumberFootnotes(once.content);

    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  it('dit ce qu’il ne peut pas trancher : deux définitions d’un numéro sans appel entre elles', () => {
    // L'appel ajouté est APRÈS l'ancien, sa définition juste dessous : les deux
    // appels précèdent les deux définitions, rien ne dit lequel va avec laquelle.
    const doc =
      'Un[^1] deux[^2].\n\nAjout[^2].\n\n[^2]: ajoutée.\n\n[^1]: un.\n[^2]: deux.\n';
    const result = renumberFootnotes(doc);

    // Plus jamais deux définitions de même numéro : chaque texte reste dans le document.
    const definitions = collectFootnotes(result.content).filter((o) => o.kind === 'definition');
    expect(new Set(definitions.map((d) => d.label)).size).toBe(definitions.length);
    // L'appel d'origine a reçu le texte ajouté : il est nommé, pas seulement
    // la définition restée sans appel.
    expect(result.content).toBe(
      'Un[^1] deux[^2].\n\nAjout[^2].\n\n[^2]: ajoutée.\n\n[^1]: un.\n[^3]: deux.\n'
    );
    expect(result.unlinked).toEqual([
      { kind: 'shared', label: '2' },
      { kind: 'definition', label: '3' },
    ]);
  });

  it('signale l’appel qu’il relie à un autre texte : une note appelée deux fois, un numéro réemployé entre les deux', () => {
    // X appelle deux fois NOTE-X ; Y, inséré entre les deux appels, reprend le
    // numéro. Pandoc donnait NOTE-X au premier X ; la règle « première
    // définition qui suit » lui donne NOTE-Y. Ce n'est pas tranchable : le dire.
    const doc = 'X[^2].\n\nY[^2].\n\n[^2]: NOTE-Y\n\nEncore X[^2].\n\n[^2]: NOTE-X\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe(
      'X[^1].\n\nY[^1].\n\n[^1]: NOTE-Y\n\nEncore X[^2].\n\n[^2]: NOTE-X\n'
    );
    expect(result.unlinked).toEqual([{ kind: 'shared', label: '1' }]);
  });

  it('ne signale pas une note appelée deux fois quand son numéro n’a qu’une définition', () => {
    const result = renumberFootnotes('A[^3] et B[^3].\n\nC[^4].\n\n[^3]: une.\n[^4]: deux.\n');

    expect(result.content).toBe('A[^1] et B[^1].\n\nC[^2].\n\n[^1]: une.\n[^2]: deux.\n');
    expect(result.unlinked).toEqual([]);
  });

  it('signale un appel sans définition et une définition sans appel', () => {
    const doc = 'Un[^1] et deux[^2].\n\n[^1]: un.\n[^5]: jamais appelée.\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe('Un[^1] et deux[^2].\n\n[^1]: un.\n[^3]: jamais appelée.\n');
    expect(result.unlinked).toEqual([
      { kind: 'reference', label: '2' },
      { kind: 'definition', label: '3' },
    ]);
  });

  it('dit aussi ce qui reste à lier quand rien n’a changé', () => {
    const result = renumberFootnotes('Un[^1].\n\n[^1]: un.\n[^2]: sans appel.\n');

    expect(result.changed).toBe(false);
    expect(result.unlinked).toEqual([{ kind: 'definition', label: '2' }]);
  });

  /**
   * Une définition collée au paragraphe, sans ligne vide avant : pandoc la lit
   * comme la suite du paragraphe et l'export l'imprime en clair (pandoc 3.13).
   * L'éditeur y voit une note : la renumérotation le dit.
   */
  it('une définition collée au paragraphe est renumérotée, et signalée', () => {
    const doc = 'Un[^1].\n\nDeux[^4].\n[^4]: collée au paragraphe.\n\n[^1]: un.\n';
    const result = renumberFootnotes(doc);

    expect(result.content).toBe('Un[^1].\n\nDeux[^2].\n[^2]: collée au paragraphe.\n\n[^1]: un.\n');
    expect(result.unlinked).toEqual([{ kind: 'glued', label: '2' }]);
  });

  it.each([
    ['sous une citation', '> Cite[^1].\n[^1]: x\n'],
    ['sous un élément de liste', '- Item[^1].\n[^1]: x\n'],
    ['en fin de ligne CRLF', 'Un[^1].\r\n[^1]: x\r\n'],
  ])('collée %s : signalée, comme pandoc la lit', (_where, doc) => {
    expect(renumberFootnotes(doc).unlinked).toEqual([{ kind: 'glued', label: '1' }]);
  });

  it.each([
    ['sous une autre définition', 'Un[^1] deux[^2].\n\n[^1]: un\n[^2]: deux\n'],
    ['sous la suite paresseuse d’une définition', 'Un[^1] deux[^2].\n\n[^1]: un\nsuite\n[^2]: deux\n'],
    ['sous une citation dans une note', 'Un[^1] deux[^2].\n\n[^1]: un\n\n    > cite\n[^2]: deux\n'],
    ['sous un titre', 'Un[^1].\n\n# Titre\n[^1]: un\n'],
    ['sous un bloc de code', 'Un[^1].\n\n```\ncode\n```\n[^1]: un\n'],
  ])('pas collée %s : pandoc en fait une note', (_where, doc) => {
    expect(renumberFootnotes(doc).unlinked).toEqual([]);
  });
});

/**
 * L'oracle est l'export : pandoc, à qui le manuscrit part. Chaque texte de
 * note doit y figurer une fois, et le texte imprimé ne garde aucun `[^n]`.
 */
describe.skipIf(!pandocAvailable())('renumberFootnotes — rendu par le vrai pandoc', () => {
  const pandocPlain = (markdown: string): { text: string; warnings: string } => {
    const run = spawnSync('pandoc', ['-f', 'markdown', '-t', 'plain', '--wrap=none'], {
      input: markdown,
      encoding: 'utf-8',
    });
    return { text: run.stdout, warnings: run.stderr };
  };

  it('un numéro réemployé : chaque texte de note est rendu une fois', () => {
    const doc =
      'Un[^1].\n\nAjout[^2].\n\n[^2]: NOTE-AJOUTEE.\n\nDeux[^2] trois[^3].\n\n' +
      '[^1]: NOTE-UN.\n[^2]: NOTE-DEUX.\n[^3]: NOTE-TROIS.\n';
    const { text, warnings } = pandocPlain(renumberFootnotes(doc).content);

    expect(warnings).not.toContain('Duplicate note');
    for (const note of ['NOTE-UN', 'NOTE-AJOUTEE', 'NOTE-DEUX', 'NOTE-TROIS']) {
      expect(text.split(note).length - 1).toBe(1);
    }
    expect(text).not.toMatch(/\[\^\d+\]/);
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
