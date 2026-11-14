/**
 * Le changement minimal d'un texte à un autre : la renumérotation des notes et le renommage d'un
 * chapitre ne réécrivent plus tout le document, seulement ce qui change.
 *
 * Un diff faux corromprait le manuscrit en silence : tout ici vérifie d'abord qu'appliquer les
 * changements au texte de départ rend **exactement** le texte d'arrivée, par la chaîne et par un
 * vrai `ChangeSet` de CodeMirror, sur des cas écrits à la main et sur plusieurs centaines de cas
 * générés (notes en tête, en fin, dans des listes imbriquées ; CRLF ; texte identique ; texte vide ;
 * caractères hors du plan multilingue de base).
 */
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { minimalChanges, type TextChange } from '../cm/minimal-changes';
import { renumberFootnotes } from '../footnote-tools';

/** De la fin vers le début : les positions sont celles du texte de départ. */
function applyToString(prev: string, changes: readonly TextChange[]): string {
  let out = prev;
  for (let i = changes.length - 1; i >= 0; i--) {
    const { from, to, insert } = changes[i];
    out = out.slice(0, from) + insert + out.slice(to);
  }
  return out;
}

/** Comme la façade : un `Text` coupé sur `\n`, où un `\r` reste un caractère. */
function applyWithCodeMirror(prev: string, changes: readonly TextChange[]): string {
  const set = ChangeSet.of(
    changes.map(({ from, to, insert }) => ({ from, to, insert: Text.of(insert.split('\n')) })),
    prev.length
  );
  return set.apply(Text.of(prev.split('\n'))).toString();
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Une position entre les deux moitiés d'un caractère hors BMP. */
const splitsPair = (text: string, at: number) =>
  at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

function expectExact(prev: string, next: string): TextChange[] {
  const changes = minimalChanges(prev, next);
  expect(applyToString(prev, changes)).toBe(next);
  expect(applyWithCodeMirror(prev, changes)).toBe(next);
  for (let i = 0; i < changes.length; i++) {
    const { from, to, insert } = changes[i];
    expect(0 <= from && from <= to && to <= prev.length).toBe(true);
    // Rien d'inutile : ni changement vide, ni texte remplacé par lui-même.
    expect(prev.slice(from, to)).not.toBe(insert);
    // Dans l'ordre, et séparés par au moins un caractère gardé.
    if (i > 0) expect(changes[i - 1].to).toBeLessThan(from);
    // Jamais au milieu d'un caractère hors BMP.
    expect(splitsPair(prev, from)).toBe(false);
    expect(splitsPair(prev, to)).toBe(false);
  }
  return changes;
}

describe('minimalChanges : appliquer les changements rend exactement le texte d’arrivée', () => {
  it.each([
    ['identique', 'Un texte.\n', 'Un texte.\n'],
    ['vide → vide', '', ''],
    ['vide → texte', '', '# Titre\n\nUn paragraphe.\n'],
    ['texte → vide', '# Titre\n\nUn paragraphe.\n', ''],
    ['même nombre de lignes', 'a\nb\nc\n', 'a\nB\nc\n'],
    ['lignes en plus', 'a\nc\n', 'a\nb1\nb2\nc\n'],
    ['lignes en moins', 'a\nb1\nb2\nc\n', 'a\nc\n'],
    ['sans fin de ligne finale', 'a\nb', 'a\nb\n'],
    ['fin de ligne finale retirée', 'a\nb\n', 'a\nb'],
    ['tout change', 'abc', 'xyz'],
    ['CRLF : une étiquette', 'A[^2].\r\n\r\n[^2]: deux.\r\n', 'A[^1].\r\n\r\n[^1]: deux.\r\n'],
    ['CRLF → LF', 'a\r\nb\r\n', 'a\nb\n'],
    ['LF → CRLF', 'a\nb\n', 'a\r\nb\r\n'],
    ['hors BMP, même moitié haute', 'x😀y', 'x😁y'],
    ['hors BMP, insertion', 'Le 𝔄 et le 𝔅.', 'Le 𝔄, le 𝔆 et le 𝔅.'],
    ['hors BMP, retrait', '𓂀𓂁𓂂', '𓂀𓂂'],
    ['blancs seuls', '\n\n\n', '\n \n\n'],
  ])('%s', (_label, prev, next) => {
    expectExact(prev, next);
  });

  it('texte identique : aucun changement', () => {
    expect(minimalChanges('Un texte.\n', 'Un texte.\n')).toEqual([]);
  });

  it('renumérotation : seules les étiquettes changent, le texte entre elles reste', () => {
    const prev = '# Titre\n\nUn[^3] mot, puis[^1] un autre.\n\nSuite[^2].\n\n[^1]: un.\n[^2]: deux.\n[^3]: trois.\n';
    const next = renumberFootnotes(prev).content;
    const changes = expectExact(prev, next);
    for (const { from, to, insert } of changes) {
      expect(prev.slice(from, to)).toMatch(/^\d*$/);
      expect(insert).toMatch(/^\d*$/);
    }
    // « mot, puis » n'est touché par aucun changement.
    const kept = prev.indexOf(' mot, puis');
    for (const { from, to } of changes) {
      expect(to <= kept || from >= kept + ' mot, puis'.length).toBe(true);
    }
  });

  it('un titre renommé : le reste du document n’est pas touché', () => {
    const body = '\n\nTexte du chapitre, long et intact.\n';
    const changes = expectExact(`# Ancien titre${body}`, `# Nouveau titre${body}`);
    for (const { to } of changes) expect(to).toBeLessThanOrEqual('# Ancien titre'.length);
  });
});

// MARK: - Cas générés

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

const WORDS = ['archives', 'Danzig', 'le', 'fonds', 'corridor', 'é', 'œuvre', '𝔄', '😀', '𓂀', 'x', ''];

function generatedDocument(rand: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const label = () => String(1 + Math.floor(rand() * 12));
  const sentence = () => {
    const words = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(WORDS));
    return words.map((w) => (rand() < 0.25 ? `${w}[^${label()}]` : w)).join(' ');
  };
  const blocks: string[] = [];
  const count = Math.floor(rand() * 7);
  for (let i = 0; i < count; i++) {
    const kind = rand();
    if (kind < 0.15) blocks.push(`# ${sentence()}`);
    else if (kind < 0.35) {
      // Notes dans des listes, imbriquées.
      blocks.push(`- ${sentence()}\n  - ${sentence()}\n    - ${sentence()}\n- ${sentence()}`);
    } else if (kind < 0.5) blocks.push(`[^${label()}]: ${sentence()}`);
    else if (kind < 0.6) blocks.push('```\n[^99]: pas une note\n```');
    else blocks.push(sentence());
  }
  // Notes en tête et en fin, parfois.
  if (rand() < 0.3) blocks.unshift(`[^${label()}] ${sentence()}`);
  if (rand() < 0.3) blocks.push(`${sentence()}[^${label()}]`);
  const lf = blocks.join('\n\n') + (rand() < 0.7 ? '\n' : '');
  return rand() < 0.3 ? lf.replace(/\n/g, '\r\n') : lf;
}

/** Retouches au hasard, par caractère entier : jamais une moitié de caractère hors BMP. */
function mutated(text: string, rand: () => number): string {
  const chars = Array.from(text);
  const edits = Math.floor(rand() * 6);
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(rand() * (chars.length + 1));
    const op = rand();
    if (op < 0.35) chars.splice(at, 0, ...Array.from(WORDS[Math.floor(rand() * WORDS.length)] + ' '));
    else if (op < 0.6) chars.splice(at, 1 + Math.floor(rand() * 5));
    else if (op < 0.8) chars.splice(at, 1, ...Array.from(rand() < 0.5 ? '\n' : '\r\n'));
    else chars.splice(at, 2, ...Array.from('😀'));
  }
  return chars.join('');
}

describe('minimalChanges : cas générés', () => {
  const rand = mulberry32(20261114);
  const cases: Array<[string, string, string]> = [];
  for (let i = 0; i < 300; i++) {
    const doc = generatedDocument(rand);
    const shape = rand();
    if (shape < 0.35) cases.push([`renumérotation ${i}`, doc, renumberFootnotes(doc).content]);
    else if (shape < 0.45) cases.push([`identique ${i}`, doc, doc]);
    else if (shape < 0.5) cases.push([`vers vide ${i}`, doc, '']);
    else if (shape < 0.55) cases.push([`depuis vide ${i}`, '', doc]);
    else cases.push([`retouches ${i}`, doc, mutated(doc, rand)]);
  }

  it.each(cases)('%s', (_label, prev, next) => {
    const changes = expectExact(prev, next);
    if (prev === next) expect(changes).toEqual([]);
  });

  it('une renumérotation ne touche que des chiffres', () => {
    const local = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const prev = generatedDocument(local);
      const next = renumberFootnotes(prev).content;
      for (const { from, to, insert } of expectExact(prev, next)) {
        expect(prev.slice(from, to)).toMatch(/^\d*$/);
        expect(insert).toMatch(/^\d*$/);
      }
    }
  });
});

describe('minimalChanges : un long chapitre', () => {
  it('mille cinq cents notes décalées d’un rang : des changements à la mesure des étiquettes', () => {
    // Trois mille lignes changées : au-delà de ce que cherche une seule passe, la recherche se coupe.
    const paragraphs = Array.from(
      { length: 1500 },
      (_, i) => `Paragraphe ${i + 1}, assez long pour ressembler à de la prose d’historien[^${i + 2}].`
    );
    const definitions = Array.from({ length: 1500 }, (_, i) => `[^${i + 2}]: Source ${i + 1}.`);
    const prev = `${paragraphs.join('\n\n')}\n\n${definitions.join('\n')}\n`;
    const next = renumberFootnotes(prev).content;
    expect(next).not.toBe(prev);

    const changes = expectExact(prev, next);
    for (const { from, to, insert } of changes) {
      expect(prev.slice(from, to)).toMatch(/^\d*$/);
      expect(insert).toMatch(/^\d*$/);
    }
  });

  it('beaucoup de lignes ajoutées, retirées et retouchées : la recherche coupée reste exacte', () => {
    const rand = mulberry32(42);
    const lines = Array.from({ length: 4000 }, (_, i) => `Ligne ${i} ${WORDS[i % WORDS.length]}`);
    const changed: string[] = [];
    for (const line of lines) {
      const roll = rand();
      if (roll < 0.08) continue;
      if (roll < 0.16) changed.push(`Ajout ${Math.floor(rand() * 1e6)}`);
      changed.push(roll < 0.4 ? line.replace('Ligne', 'ligne') : line);
    }
    expectExact(lines.join('\n'), changed.join('\n'));
  });

  it('deux textes sans rien de commun : le résultat reste exact', () => {
    // La recherche s'arrête au bout de son budget et rend des plages plus larges.
    const prev = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const next = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expectExact(prev, next);
  });
});
