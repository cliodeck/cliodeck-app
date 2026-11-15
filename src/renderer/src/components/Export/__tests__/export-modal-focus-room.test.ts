/**
 * J13, revue : dans les fenêtres d'export, l'anneau de focus d'un champ n'est pas rogné par le
 * conteneur qui défile.
 *
 * `index.css` dessine l'anneau hors du champ (`outline` de 2 px, décalé de 2 px, en
 * `!important`), et un conteneur qui défile (`overflow: auto`) coupe tout ce qui dépasse de sa
 * marge intérieure. Quand le corps de la fenêtre de présentation est devenu ce conteneur (J13),
 * sans marge intérieure, ses champs pleine largeur touchaient son bord : l'anneau était coupé à
 * gauche, à droite et en bas, dès le clic dans le titre (un champ texte prend `:focus-visible`
 * au clic). Sur `main`, c'était le cadre qui défilait, avec ses 16 px de marge intérieure.
 *
 * Le test lit les feuilles comme du texte, avec les jetons d'`index.css` dans les deux densités
 * (confortable et compacte) : jsdom ne résout pas `var()` dans un raccourci, et
 * `padding: var(--spacing-lg)` y vaut `0`. Les feuilles sont celles qu'importent les trois
 * fenêtres. Chaque règle qui fait défiler un élément (`overflow`, `overflow-x` ou `overflow-y` à
 * `auto` ou `scroll`) doit lui laisser, de chaque côté, au moins l'épaisseur de l'anneau plus son
 * décalage.
 *
 * Ce qu'il ne voit pas : un défilement posé par un attribut `style` ou par une autre feuille, une
 * marge intérieure déclarée sous un autre sélecteur que celui qui fait défiler, et un champ qui ne
 * touche pas le bord (il a plus de place, et le test lui en demande autant).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const RENDERER = path.resolve(__dirname, '../../..');
const EXPORT_DIR = path.resolve(__dirname, '..');
const MODALS = ['PDFExportModal.tsx', 'WordExportModal.tsx', 'PresentationExportModal.tsx'];
const ROOT_FONT_SIZE = 16;

type Tokens = Record<string, string>;
interface Rule {
  selector: string;
  decls: Array<[string, string]>;
}

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Coupe un texte sur `sep`, hors des parenthèses (`calc(1rem - 4px)` reste entier). */
function splitTopLevel(text: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && sep.test(ch)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Les règles d'une feuille, une par sélecteur de la liste ; les règles `@` sont sautées. */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith('@')) continue;
    const decls = splitTopLevel(match[2], /;/).map((d): [string, string] => {
      const colon = d.indexOf(':');
      return [d.slice(0, colon).trim(), d.slice(colon + 1).replace(/!important/, '').trim()];
    });
    for (const selector of splitTopLevel(prelude, /,/)) found.push({ selector, decls });
  }
  return found;
}

/** Les propriétés personnalisées d'un bloc d'`index.css` (`:root`, `body.density-compact`). */
function tokensOf(css: string, prelude: string): Tokens {
  const code = stripComments(css);
  const start = code.indexOf(`${prelude} {`);
  expect(start, prelude).toBeGreaterThanOrEqual(0);
  const body = code.slice(code.indexOf('{', start) + 1, code.indexOf('}', start));
  const tokens: Tokens = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
  return tokens;
}

/** Une longueur en pixels : `4px`, `1rem`, `0`, `var(--x)`, `calc(a - b)`. */
function toPx(value: string, tokens: Tokens): number {
  let v = value;
  for (let i = 0; i < 10 && v.includes('var('); i++) {
    v = v.replace(/var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_, name: string, fallback?: string) => {
      const resolved = tokens[name] ?? fallback;
      if (resolved === undefined) throw new Error(`jeton inconnu : ${name}`);
      return resolved;
    });
  }
  v = v.replace(/^calc\((.*)\)$/, '$1');
  const terms = v.split(/\s+/);
  let total = 0;
  let sign = 1;
  for (const term of terms) {
    if (term === '+' || term === '-') {
      sign = term === '-' ? -1 : 1;
      continue;
    }
    const m = /^(-?[\d.]+)(px|rem)?$/.exec(term);
    if (!m || (m[2] === undefined && Number(m[1]) !== 0)) throw new Error(`longueur illisible : ${value}`);
    total += sign * Number(m[1]) * (m[2] === 'rem' ? ROOT_FONT_SIZE : 1);
    sign = 1;
  }
  return total;
}

/** Haut, droite, bas, gauche, d'après les déclarations `padding…` de ces règles, dans l'ordre. */
function paddingOf(decls: Array<[string, string]>, tokens: Tokens): [number, number, number, number] {
  const sides: [number, number, number, number] = [0, 0, 0, 0];
  const longhands = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  for (const [prop, value] of decls) {
    if (prop === 'padding') {
      const v = splitTopLevel(value, /\s/).map((x) => toPx(x, tokens));
      const [t, r = t, b = t, l = r] = v;
      sides.splice(0, 4, t, r, b, l);
    } else if (longhands.includes(prop)) {
      sides[longhands.indexOf(prop)] = toPx(value, tokens);
    }
  }
  return sides;
}

/** Les feuilles qu'importe une fenêtre (`import './X.css'`). */
function sheetsOf(modal: string): string[] {
  const source = fs.readFileSync(path.join(EXPORT_DIR, modal), 'utf8');
  return [...source.matchAll(/^import\s+'(\.[^']+\.css)';/gm)].map((m) => path.join(EXPORT_DIR, m[1]));
}

const INDEX = fs.readFileSync(path.join(RENDERER, 'index.css'), 'utf8');

/** L'anneau de focus d'`index.css` : épaisseur plus décalage, en pixels. */
function ringReach(): number {
  const m = /:focus-visible\s*\{[^}]*?outline:\s*([\d.]+)px[^;]*;[^}]*?outline-offset:\s*([\d.]+)px/.exec(
    stripComments(INDEX),
  );
  expect(m, 'anneau de focus d’index.css').not.toBeNull();
  return Number(m![1]) + Number(m![2]);
}

const comfortable = tokensOf(INDEX, ':root');
const DENSITIES: Array<[string, Tokens]> = [
  ['confortable', comfortable],
  ['compacte', { ...comfortable, ...tokensOf(INDEX, 'body.density-compact') }],
];

describe('fenêtres d’export : place de l’anneau de focus', () => {
  const reach = ringReach();

  it.each(MODALS)('%s : le conteneur qui défile laisse la place de l’anneau, de chaque côté', (modal) => {
    const sheets = sheetsOf(modal);
    expect(sheets.length).toBeGreaterThan(0);
    const all = sheets.flatMap((s) =>
      rules(fs.readFileSync(s, 'utf8')).map((r) => ({ ...r, sheet: path.basename(s) })),
    );
    const scrolling = all.filter((r) =>
      r.decls.some(([p, v]) => /^overflow(-[xy])?$/.test(p) && /\b(auto|scroll)\b/.test(v)),
    );
    // Chaque fenêtre a un conteneur qui défile : sans lui, le test passerait à vide.
    expect(scrolling.length, modal).toBeGreaterThan(0);

    for (const rule of scrolling) {
      const decls = all.filter((r) => r.selector === rule.selector).flatMap((r) => r.decls);
      for (const [density, tokens] of DENSITIES) {
        const [top, right, bottom, left] = paddingOf(decls, tokens);
        expect(
          { top, right, bottom, left },
          `${rule.sheet} ${rule.selector}, densité ${density} : anneau de ${reach} px`,
        ).toEqual({
          top: Math.max(top, reach),
          right: Math.max(right, reach),
          bottom: Math.max(bottom, reach),
          left: Math.max(left, reach),
        });
      }
    }
  });
});
