import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { pandocAvailable } from '../../../backend/__tests__/helpers/native-guards';
import { insertDraftAtOffset } from '../../renderer/src/components/Brainstorm/messageToDraft';
import { createDocState, readDocText } from '../cm/fidelity';
import { proposals, type ProposalAdjudicationEvent } from '../proposals';
import { addProposalEffect, afterProposalsEffect, appendsAfterProposals } from '../proposals/state';
import {
  collectFootnoteDefinitions,
  collectFootnotes,
  planFootnoteInsertion,
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

/**
 * L10-6 : l'export Word interne retirait les définitions ligne à ligne, jusque dans un bloc de
 * code, et ne gardait d'une note à plusieurs paragraphes qu'un seul. Il les prend désormais à
 * leurs positions dans l'arbre Lezer, comme le préfixage par chapitre.
 */
describe('collectFootnoteDefinitions', () => {
  it('rend chaque définition, du `[^` à la fin de son dernier paragraphe', () => {
    const doc = 'Texte[^1].\n\n[^1]: Premier.\n\n    Second.\n\nCorps.\n';
    const [def] = collectFootnoteDefinitions(doc);

    expect(collectFootnoteDefinitions(doc)).toHaveLength(1);
    expect(def.label).toBe('1');
    expect(doc.slice(def.from, def.to)).toBe('[^1]: Premier.\n\n    Second.');
    expect(doc.slice(def.bodyFrom, def.to)).toBe('Premier.\n\n    Second.');
  });

  it('ignore une ligne de définition dans un bloc de code', () => {
    const doc = 'Note[^a].\n\n```\n[^a]: exemple\n```\n\n[^a]: Vraie.\n';
    const defs = collectFootnoteDefinitions(doc);

    expect(defs.map((d) => doc.slice(d.bodyFrom, d.to))).toEqual(['Vraie.']);
  });

  it('sépare deux définitions consécutives, et garde leur ordre', () => {
    const doc = '[^a]: A.\n[^lester-danzig]: B.\n';

    expect(collectFootnoteDefinitions(doc).map((d) => [d.label, doc.slice(d.from, d.to)])).toEqual([
      ['a', '[^a]: A.'],
      ['lester-danzig', '[^lester-danzig]: B.'],
    ]);
  });

  it('une définition vide : son corps l’est aussi', () => {
    const doc = 'X[^1].\n\n[^1]:\n';
    const [def] = collectFootnoteDefinitions(doc);

    expect(doc.slice(def.bodyFrom, def.to)).toBe('');
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

/** Générateur reproductible : une graine, toujours les mêmes cas. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROPOSAL_LABELS = {
  heading: 'proposition IA',
  accept: 'accepter',
  reject: 'rejeter',
  modify: 'modifier',
  acceptShort: 'accepter',
  rejectShort: 'rejeter',
  modifyShort: 'modifier',
  rejectionPrompt: 'pourquoi ?',
  apply: 'appliquer',
  cancel: 'annuler',
};

/**
 * L01-6 : insérer une note réécrivait tout le document, du curseur à la fin, et invalidait les
 * propositions IA en attente plus loin (S14-1-8). Le plan est fait de deux insertions localisées,
 * l'appel au curseur et la définition en fin de document, et rend le même texte qu'avant.
 */
describe('planFootnoteInsertion', () => {
  /** L'ancien calcul d'`insertFootnoteAtPosition`, recopié tel quel : la référence. */
  function previousComputation(content: string, position: number): { text: string; cursor: number } {
    const footnoteNumber = nextFootnoteNumber(content);
    const refText = `[^${footnoteNumber}]`;
    const defText = `[^${footnoteNumber}]: `;
    const afterRef = content.slice(position);
    const defRegex = /\n\n(\[\^\d+\]:[\s\S]*)$/;
    const defMatch = afterRef.match(defRegex);
    let insert: string;
    if (defMatch) {
      const afterRefWithoutDefs = afterRef.slice(0, defMatch.index);
      const existingDefs = defMatch[1].trimEnd();
      insert = refText + afterRefWithoutDefs + '\n\n' + existingDefs + '\n\n' + defText;
    } else {
      insert = refText + afterRef.trimEnd() + '\n\n' + defText;
    }
    return { text: content.slice(0, position) + insert, cursor: position + insert.length };
  }

  function applied(doc: string, changes: ReadonlyArray<{ from: number; to: number; insert: string }>): string {
    let out = doc;
    for (let i = changes.length - 1; i >= 0; i--) {
      out = out.slice(0, changes[i].from) + changes[i].insert + out.slice(changes[i].to);
    }
    return out;
  }

  const DOC = 'Un mot ici.\n\nDeuxième paragraphe.\n\nTroisième paragraphe.\n';
  const WITH_DEFS = 'Un[^1] mot[^2].\n\nSuite.\n\n[^1]: Un.\n[^2]: Deux.\n';

  it.each([
    ['sans définition, au milieu', DOC, DOC.indexOf(' ici')],
    ['sans définition, au début', DOC, 0],
    ['sans définition, au bout du dernier mot', DOC, DOC.trimEnd().length],
    ['curseur dans les blancs de fin', DOC, DOC.length],
    ['curseur entre deux fins de ligne finales', 'Texte.\n\n\n', 'Texte.\n\n'.length],
    ['définitions groupées en fin de document', WITH_DEFS, WITH_DEFS.indexOf(' mot')],
    ['curseur dans une définition', WITH_DEFS, WITH_DEFS.indexOf('Deux.')],
    ['identifiant libre', 'A[^lester].\n\n[^lester]: libre.\n', 1],
    ['numéro suivant après un [^99] de code', '```\n[^99]\n```\n\nTexte[^4].\n\n[^4]: q.\n', 0],
    ['document vide', '', 0],
    ['sans fin de ligne finale', 'Une phrase.', 3],
    ['blancs de fin variés', 'Une phrase.  \n \n', 3],
    ['liste imbriquée', '- un[^1]\n  - deux\n\n[^1]: n.\n', '- un[^1]\n  - de'.length],
    ['hors BMP', 'Le 𝔄 et 😀.\n', 'Le 𝔄'.length],
  ])('%s : même texte que l’ancien calcul', (_label, doc, position) => {
    const plan = planFootnoteInsertion(doc, position);
    const reference = previousComputation(doc, position);

    expect(applied(doc, plan.changes)).toBe(reference.text);
    expect(plan.cursor).toBe(reference.cursor);
    expect(plan.footnoteNumber).toBe(nextFootnoteNumber(doc));
  });

  it('deux insertions : l’appel au curseur, la définition en fin de document, rien entre elles', () => {
    const at = DOC.indexOf(' ici');
    const plan = planFootnoteInsertion(DOC, at);

    expect(plan.changes).toHaveLength(2);
    expect(plan.changes[0]).toEqual({ from: at, to: at, insert: '[^1]' });
    // Ce qui suit le curseur reste en place : seul le bout du document reçoit la définition.
    expect(plan.changes[1].from).toBeGreaterThanOrEqual(DOC.trimEnd().length);
    expect(plan.changes[1].to).toBe(DOC.length);
    expect(plan.footnoteNumber).toBe(1);
  });

  it('le numéro suit le plus grand des numéros réels', () => {
    expect(planFootnoteInsertion(WITH_DEFS, 0).footnoteNumber).toBe(3);
  });

  it('document CRLF : la note entre sans RangeError, et le fichier reste CRLF uniforme', () => {
    const crlf = 'Les archives.\r\n\r\nUn paragraphe.\r\nUne suite.\r\n';
    const state = createDocState(crlf);
    // Les offsets du document : une fin de ligne y vaut 1, comme sous le curseur.
    const doc = state.doc.toString();
    const at = doc.indexOf(' paragraphe');
    const plan = planFootnoteInsertion(doc, at);

    const next = state.update({
      changes: plan.changes.map(({ from, to, insert }) => ({ from, to, insert: Text.of(insert.split('\n')) })),
      selection: { anchor: plan.cursor },
    }).state;
    const written = readDocText(next);

    expect(written).toBe('Les archives.\r\n\r\nUn[^1] paragraphe.\r\nUne suite.\r\n\r\n[^1]: ');
    expect(written.replace(/\r\n/g, '')).not.toContain('\n');
    expect(next.selection.main.head).toBe(next.doc.length);
  });

  /**
   * Revue L01-6 : la définition va au bout du document, là même où attend un brouillon envoyé sans
   * curseur posé. Une proposition qui finit au bout du texte ou dans les blancs de fin les garde, et
   * la définition s'ajoute après eux, marquée `afterProposals`.
   */
  describe('une proposition en attente au bout du document', () => {
    const appended = (doc: string, at: number) => `${doc.slice(0, at)}[^1]${doc.slice(at)}\n\n[^1]: `;

    it.each([
      ['après la fin de ligne finale', DOC, DOC.length],
      ['dans les blancs de fin', 'Texte.\n\n\n', 'Texte.\n'.length],
      ['au bout d’un texte sans fin de ligne finale', 'Une phrase.', 'Une phrase.'.length],
      ['au bout du texte, suivi d’espaces', 'Une phrase.  \n', 'Une phrase.'.length],
    ])('%s : les blancs restent, la définition vient après eux', (_label, doc, anchor) => {
      const at = 2;
      const plan = planFootnoteInsertion(doc, at, [{ from: anchor, to: anchor }]);

      expect(plan.changes).toEqual([
        { from: at, to: at, insert: '[^1]' },
        { from: doc.length, to: doc.length, insert: '\n\n[^1]: ', afterProposals: true },
      ]);
      expect(applied(doc, plan.changes)).toBe(appended(doc, at));
      expect(plan.cursor).toBe(appended(doc, at).length);
    });

    it.each([
      ['plus haut dans le texte', DOC, 0],
      ['au bout du dernier mot, avant la fin de ligne finale', DOC, DOC.trimEnd().length],
      ['au bout du dernier mot, avant deux fins de ligne', 'Texte.\n\n', 'Texte.'.length],
    ])('%s : la définition ne la touche pas, le texte est celui d’avant', (_label, doc, anchor) => {
      const at = 2;
      const plan = planFootnoteInsertion(doc, at, [{ from: anchor, to: anchor }]);

      expect(plan.changes.some((c) => c.afterProposals)).toBe(false);
      expect(applied(doc, plan.changes)).toBe(previousComputation(doc, at).text);
    });

    it('curseur dans les blancs de fin : l’appel et la définition y vont, comme avant', () => {
      const plan = planFootnoteInsertion(DOC, DOC.length, [{ from: DOC.length, to: DOC.length }]);
      expect(plan.changes).toEqual([{ from: DOC.length, to: DOC.length, insert: '[^1]\n\n[^1]: ' }]);
    });

    /**
     * Seconde revue L01-6 : la note posée au bout du dernier paragraphe, ou dans les blancs de fin,
     * avant un brouillon qui attend plus loin. Un seul changement du curseur à la fin le touchait,
     * alors qu'une frappe au même curseur le laisse.
     */
    it.each([
      ['curseur au bout du dernier mot, brouillon après la fin de ligne finale', DOC, DOC.trimEnd().length, DOC.length],
      ['curseur au bout du dernier mot, brouillon dans les blancs de fin', 'Texte.\n\n\n', 'Texte.'.length, 'Texte.\n'.length],
      ['curseur dans les blancs de fin, brouillon plus loin', 'Texte.\n\n\n', 'Texte.\n'.length, 'Texte.\n\n\n'.length],
      ['curseur au bout du texte, suivi d’espaces', 'Une phrase.  \n', 'Une phrase.'.length, 'Une phrase.  \n'.length],
    ])('%s : l’appel au curseur, les blancs restent, la définition vient après eux', (_label, doc, at, anchor) => {
      const plan = planFootnoteInsertion(doc, at, [{ from: anchor, to: anchor }]);

      expect(plan.changes).toEqual([
        { from: at, to: at, insert: '[^1]' },
        { from: doc.length, to: doc.length, insert: '\n\n[^1]: ', afterProposals: true },
      ]);
      expect(applied(doc, plan.changes)).toBe(appended(doc, at));
      expect(plan.cursor).toBe(appended(doc, at).length);
    });

    it('témoin : un brouillon avant le curseur, dans les blancs de fin, ne change rien au calcul d’avant', () => {
      const doc = 'Texte.\n\n\n';
      const at = doc.length;
      const plan = planFootnoteInsertion(doc, at, [{ from: 'Texte.\n'.length, to: 'Texte.\n'.length }]);
      expect(plan.changes).toEqual([{ from: at, to: at, insert: '[^1]\n\n[^1]: ' }]);
      expect(applied(doc, plan.changes)).toBe(previousComputation(doc, at).text);
    });
  });

  /**
   * Cas générés, sur un vrai état CM6 avec le vrai champ des propositions : un brouillon posé comme
   * le pose `insertDraftAtCursor` (padding d'`insertDraftAtOffset`), une note insérée ailleurs comme
   * le fait la façade, puis le brouillon accepté.
   */
  it('cas générés : la note ne retire que la proposition qu’elle touche, et la définition reste un bloc à part', () => {
    const rand = mulberry32(20261114);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
    const PARAGRAPHS = ['Les archives de Danzig.', 'Un appel[^1] ici.', '- un\n  - deux', '𝔄 et 😀.', '> citée'];
    const TAILS = ['', '\n', '\n\n', '\n\n\n', '  \n', ' ', '\n \n', '\n\n[^1]: Déjà là.\n'];
    const DRAFT = 'Brouillon.';
    let checked = 0;

    for (let i = 0; i < 400; i++) {
      const count = 1 + Math.floor(rand() * 4);
      const doc = Array.from({ length: count }, () => pick(PARAGRAPHS)).join(pick(['\n\n', '\n'])) + pick(TAILS);
      const end = doc.trimEnd().length;
      if (end === 0) continue;
      // Ni au milieu d'un caractère hors BMP, ni dans une plage où CM6 ne poserait pas de curseur.
      const positions = Array.from({ length: doc.length + 1 }, (_, k) => k).filter(
        (k) => !(k > 0 && k < doc.length && /[\uDC00-\uDFFF]/.test(doc[k]))
      );
      const at = pick(positions);
      const anchor = pick(positions);

      const events: ProposalAdjudicationEvent[] = [];
      const instance = proposals({ onEvent: (e) => events.push(e), labels: PROPOSAL_LABELS });
      // Ce que `insertDraftAtCursor` propose : le brouillon et son padding de bloc.
      const padded = insertDraftAtOffset(doc, anchor, DRAFT);
      const insert = padded.slice(anchor, anchor + (padded.length - doc.length));
      let state = EditorState.create({ doc, extensions: instance.extension }).update({
        effects: addProposalEffect.of({
          id: 'p',
          range: { from: anchor, to: anchor },
          category: 'brainstorm-draft',
          original: '',
          proposed: insert,
          source: { model: 'm', task: 't' },
          createdAt: new Date().toISOString(),
        }),
      }).state;

      const plan = planFootnoteInsertion(doc, at, state.field(instance.field).map((p) => p.range));
      state = state.update({
        changes: plan.changes.map(({ from, to, insert: text }) => ({ from, to, insert: text })),
        // Comme la façade (`applyChanges`) : l'ajout marqué `afterProposals` porte l'effet.
        effects: appendsAfterProposals(plan.changes, doc.length)
          ? afterProposalsEffect.of({ from: doc.length, to: doc.length })
          : [],
      }).state;
      const label = JSON.stringify({ doc, at, anchor });
      const n = plan.footnoteNumber;

      // Seule la note posée sur la proposition la retire : l'appel au même endroit, comme une frappe.
      // Un curseur dans les blancs de fin, avant elle, la laisse aussi (seconde revue L01-6).
      const touched = anchor === at;
      expect(events.map((e) => e.decision), label).toEqual(touched ? ['invalidated'] : []);
      const text = state.doc.toString();
      expect(text.endsWith(`[^${n}]: `), label).toBe(true);
      if (touched) continue;

      const [pending] = state.field(instance.field);
      state = state.update({ changes: { from: pending.range.from, to: pending.range.to, insert: pending.proposed } }).state;
      const accepted = state.doc.toString();
      expect(accepted.split(DRAFT), label).toHaveLength(2);
      // La définition reste un bloc à part : une ligne vide devant elle.
      expect(accepted.endsWith(`\n\n[^${n}]: `), label).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });
});
