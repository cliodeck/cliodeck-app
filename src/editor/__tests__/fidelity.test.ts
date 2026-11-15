import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  createDocState,
  detectLineSeparator,
  readDocText,
  roundTrip as cm6RoundTrip,
} from '../cm/fidelity';

/**
 * Test de fidélité de l'éditeur — Phase 0 du plan de migration CM6
 * (docs/PLAN_migration-editeur-cm6.md, décision cadre n°1).
 *
 * Contrat : charger(doc) → sauvegarder() === doc, octet par octet, pour tout
 * le corpus test-fixtures/editor/. L'éditeur ne sérialise jamais : il charge
 * une chaîne et restitue la même chaîne.
 *
 * Les moteurs s'enregistrent dans ENGINES au fil des phases ; la liste est
 * vide jusqu'à la Phase 1 (socle CM6). Milkdown n'y figurera jamais : il
 * resérialise via ProseMirror (échappements `\[@clef\]`, réécriture des
 * notes) et échoue par construction sur ce corpus — c'est une justification
 * documentée de la migration, pas un bug à corriger.
 */

interface EditorEngine {
  name: string;
  /** Charge la chaîne dans le moteur et restitue le document sans édition. */
  roundTrip(source: string): string | Promise<string>;
}

const ENGINES: EditorEngine[] = [{ name: 'cm6', roundTrip: cm6RoundTrip }];

const CORPUS_DIR = fileURLToPath(
  new URL('../../../test-fixtures/editor/', import.meta.url)
);

const fixtures = readdirSync(CORPUS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

const read = (name: string): string =>
  readFileSync(path.join(CORPUS_DIR, name), 'utf-8');

describe('corpus de fidélité (intégrité des fixtures)', () => {
  it('couvre tous les cas exigés par la Phase 0', () => {
    expect(fixtures).toEqual([
      'bom.md',
      'citations.md',
      'code-blocks.md',
      'footnotes.md',
      'frontmatter.md',
      'kitchen-sink.md',
      'line-endings-crlf.md',
      'line-endings-mixed.md',
      'links-images.md',
      'milkdown-artifacts.md',
      'non-ascii.md',
      'slides-deck.md',
      'slides-sans-frontmatter.md',
      'tables-tasklists.md',
      'whitespace-no-final-newline.md',
    ]);
  });

  // Ces tests échouent si un outil (git, éditeur, formateur) normalise les
  // fixtures : ils protègent le corpus lui-même, pas le moteur.
  it('conserve les fins de ligne mixtes CRLF + LF', () => {
    const doc = read('line-endings-mixed.md');
    expect(doc).toContain('\r\n');
    expect(doc).toMatch(/[^\r]\n/);
  });

  it('conserve un fichier uniformément CRLF', () => {
    const doc = read('line-endings-crlf.md');
    expect(doc).toContain('\r\n');
    expect(doc.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('conserve le BOM UTF-8 en tête', () => {
    expect(read('bom.md').startsWith('\uFEFF# ')).toBe(true);
  });

  it('conserve les blancs significatifs et l’absence de saut final', () => {
    const doc = read('whitespace-no-final-newline.md');
    expect(doc).toContain('  \n'); // saut de ligne dur markdown
    expect(doc).toContain('\t\n'); // tabulation finale
    expect(doc.endsWith('\n')).toBe(false);
  });

  it('contient les constructions savantes du dialecte cible', () => {
    const citations = read('citations.md');
    expect(citations).toContain('[@lester1932, p. 12]'); // locator
    expect(citations).toContain('; @'); // cluster
    expect(citations).toMatch(/(^|\s)@lester1932\b/m); // citation nue

    const footnotes = read('footnotes.md');
    expect(footnotes).toContain('[^1]');
    expect(footnotes).toContain('[^lester-danzig]:'); // identifiant libre
  });

  it('contient les artefacts hérités de Milkdown', () => {
    const doc = read('milkdown-artifacts.md');
    expect(doc).toContain('\\[@lester1932\\]'); // citation échappée
    expect(doc).toContain('<!-- cliodeck-gen mode='); // marqueur de provenance
    expect(doc).toContain('<!-- /cliodeck-gen -->');
  });

  it('contient du non-ASCII (corpus Lester : allemand, polonais, français)', () => {
    const doc = read('non-ascii.md');
    for (const s of ['Straße', 'Gdańsk', 'œuvre', '«', '„']) {
      expect(doc).toContain(s);
    }
  });
});

/**
 * Régression (2026-07-19, chantier chapitres) : le corpus ne contient aucun
 * fichier UNIFORMÉMENT CRLF — le cas passait donc entre les mailles alors
 * que `doc.toString()` normalise les fins de ligne. Toute lecture destinée
 * au disque passe désormais par `readDocText` (= `sliceDoc`).
 */
describe('fidélité des fins de ligne CRLF', () => {
  const CRLF = '# Titre\r\n\r\nUn paragraphe.\r\nUne autre ligne.\r\n';

  it('restitue un document CRLF sans le convertir en LF', () => {
    expect(cm6RoundTrip(CRLF)).toBe(CRLF);
  });

  it('`doc.toString()` normalise — c’est pourquoi il est proscrit', () => {
    // Documente le piège : la lecture naïve perdrait les CR à la sauvegarde.
    expect(createDocState(CRLF).doc.toString()).not.toBe(CRLF);
    expect(readDocText(createDocState(CRLF))).toBe(CRLF);
  });
});

describe('détection du séparateur de ligne', () => {
  it('choisit CRLF pour un fichier uniformément CRLF', () => {
    expect(detectLineSeparator('a\r\nb\r\n')).toBe('\r\n');
  });
  it('choisit LF pour un fichier LF ou mixte (les \\r restent du contenu)', () => {
    expect(detectLineSeparator('a\nb\n')).toBe('\n');
    expect(detectLineSeparator('a\r\nb\n')).toBe('\n');
    expect(detectLineSeparator('sans saut')).toBe('\n');
  });
  it('un `\\r` isolé fait un fichier mixte, même entre des CRLF', () => {
    expect(detectLineSeparator('a\r\nb\rc\r\n')).toBe('\n');
    expect(detectLineSeparator('a\r\nb\r')).toBe('\n');
  });
});

/**
 * Un fichier CRLF déclarait `\r\n` comme séparateur : CM6 ne coupait plus une chaîne insérée que
 * sur lui, et un `\n` restait à l'intérieur d'une « ligne ». Toute commande qui insère une chaîne
 * (collage, Cmd+Maj+Alt+Bas, remplacer par `\n`) rendait le fichier mixte, et ses `\r` s'affichaient
 * à la réouverture (S14-1-24).
 */
describe('un fichier uniformément CRLF reçoit du texte', () => {
  const CRLF = 'a\r\nb\r\nc';

  it('`replaceSelection("X\\nY")` : quatre lignes, et le fichier reste uniforme', () => {
    const state = createDocState(CRLF);
    const next = state.update(state.replaceSelection('X\nY')).state;

    expect(next.doc.lines).toBe(4);
    expect(readDocText(next)).toBe('X\r\nYa\r\nb\r\nc');
  });

  it('un changement en chaîne brute, comme ceux des commandes de CM6, aussi', () => {
    const state = createDocState(CRLF);
    const next = state.update({ changes: { from: state.doc.length, insert: '\nd\r\ne\rf' } }).state;

    expect(next.doc.lines).toBe(6);
    expect(readDocText(next)).toBe('a\r\nb\r\nc\r\nd\r\ne\r\nf');
  });
});

describe('un fichier mixte reste mixte : rien n’est réécrit en douce', () => {
  it('ses `\\r` restent des caractères, et une insertion n’en ajoute ni n’en retire', () => {
    const source = read('line-endings-mixed.md');
    const state = createDocState(source);
    const at = source.indexOf('\n\n') + 1;
    const next = state.update({ changes: { from: at, insert: 'X\nY' } }).state;

    expect(readDocText(next)).toBe(source.slice(0, at) + 'X\nY' + source.slice(at));
  });

  it('un `\\r` isolé entre des CRLF reste un caractère : ni une fin de ligne, ni retiré', () => {
    const source = 'a\r\nb\rc\r\n';
    const state = createDocState(source);
    const next = state.update({ changes: { from: 0, insert: 'X' } }).state;

    expect(next.doc.lines).toBe(3);
    expect(readDocText(next)).toBe('Xa\r\nb\rc\r\n');
  });
});

describe('fidélité octet par octet : charger(doc) → sauvegarder() === doc', () => {
  for (const engine of ENGINES) {
    describe(engine.name, () => {
      for (const fixture of fixtures) {
        it(fixture, async () => {
          const source = read(fixture);
          expect(await engine.roundTrip(source)).toBe(source);
        });
      }
    });
  }
});
