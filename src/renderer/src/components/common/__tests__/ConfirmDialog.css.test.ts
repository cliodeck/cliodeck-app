/**
 * Le dialogue de confirmation dit à l'œil quel bouton Entrée actionnera (BT1-7, contrôle C48).
 *
 * Confirmer portait l'aplat d'accent du bouton principal, et Annuler, qui a le focus, n'avait
 * qu'un anneau `:focus-visible`. Ce focus est posé par script : après un clic de souris, Chromium
 * n'allume pas `:focus-visible`, et au second dialogue de la purge seul Confirmer avait l'air
 * actif. jsdom ne calcule ni `:focus-visible` ni la cascade : la feuille de style fait foi, l'e2e
 * `journey-confirm-danger` mesure le reste.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '../ConfirmDialog.css'), 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim()),
  body: m[2],
}));
const rulesFor = (pattern: RegExp) => rules.filter((r) => r.selectors.some((s) => pattern.test(s)));

describe('ConfirmDialog.css', () => {
  it('Confirmer n’a plus l’aplat d’accent du bouton principal, ni de couleur en dur', () => {
    const confirm = rulesFor(/\.confirm-dialog-btn-confirm\b/);
    expect(confirm.length).toBeGreaterThan(0);
    for (const { body } of confirm) {
      expect(body).not.toMatch(/background(-color)?:\s*var\(--color-accent(-hover|-active)?\)/);
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it('en danger, Confirmer prend la couleur du danger', () => {
    const danger = rulesFor(/\.confirm-dialog-btn-confirm\.is-danger\b/);
    expect(danger.map((r) => r.body).join('\n')).toContain('var(--color-danger)');
  });

  it('le focus des boutons se voit sur `:focus`, pas seulement sur `:focus-visible`', () => {
    const focus = rulesFor(/\.confirm-dialog-(footer button|btn-cancel)[^,]*:focus(?![\w-])/);
    expect(focus.map((r) => r.body).join('\n')).toMatch(/outline:\s*\d+px solid var\(--color-accent\)/);
  });
});

/**
 * Sans aplat, le libellé de Confirmer se lit directement sur le panneau du dialogue. En jetons
 * purs, il tombait sous le seuil AA (4,5:1 pour un texte de 14 px) : 3,40:1 pour l'accent en
 * thème sombre, 2,75:1 pour le danger survolé, et 3,89:1 pour le danger survolé en thème clair.
 * Au second dialogue d'une purge, la souris est restée sur Confirmer : c'est l'état survolé qu'on
 * lit. Le calcul part des jetons d'`index.css`, sombre (`:root`) et clair (`body.theme-light`).
 */
describe('ConfirmDialog.css : le libellé de Confirmer se lit', () => {
  type Rgba = [number, number, number, number];
  const AA_NORMAL_TEXT = 4.5;

  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
  const indexCss = stripComments(fs.readFileSync(path.join(__dirname, '../../../index.css'), 'utf8'));
  const blockOf = (source: string, selector: string) =>
    [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === selector)?.[2] ?? '';
  const tokensOf = (body: string) =>
    Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const darkTokens = tokensOf(blockOf(indexCss, ':root'));
  const themes: Record<string, Record<string, string>> = {
    sombre: darkTokens,
    clair: { ...darkTokens, ...tokensOf(blockOf(indexCss, 'body.theme-light')) },
  };

  /** Coupe aux virgules de premier niveau : `color-mix(in srgb, var(--a) 8%, transparent)`. */
  const splitTopLevel = (args: string) => {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of args) {
      if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      current += char;
    }
    parts.push(current.trim());
    return parts;
  };

  /** Ce que Chromium calcule pour `var()`, `#rrggbb`, `transparent` et `color-mix(in srgb, …)`. */
  const resolve = (value: string, tokens: Record<string, string>): Rgba => {
    const v = value.trim();
    const variable = /^var\((--[\w-]+)\)$/.exec(v);
    if (variable) return resolve(tokens[variable[1]] ?? '', tokens);
    if (v === 'transparent') return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{6})$/i.exec(v);
    if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
    const mix = /^color-mix\(in srgb,(.*)\)$/s.exec(v);
    if (mix) {
      const [a, b] = splitTopLevel(mix[1]).map((part) => {
        const pct = /\s(\d+(?:\.\d+)?)%$/.exec(part);
        return { color: resolve(pct ? part.slice(0, pct.index) : part, tokens), pct: pct ? Number(pct[1]) / 100 : null };
      });
      const pa = a.pct ?? 1 - (b.pct ?? 0.5);
      const pb = b.pct ?? 1 - pa;
      // Interpolation prémultipliée : un mélange avec `transparent` garde la teinte, perd l'opacité.
      const alpha = a.color[3] * pa + b.color[3] * pb;
      const channel = (i: number) =>
        alpha === 0 ? 0 : (a.color[i] * a.color[3] * pa + b.color[i] * b.color[3] * pb) / alpha;
      return [channel(0), channel(1), channel(2), alpha];
    }
    throw new Error(`couleur non évaluée : ${v}`);
  };

  const over = (top: Rgba, under: Rgba): Rgba =>
    [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
  const luminance = ([r, g, b]: Rgba) => {
    const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (x: Rgba, y: Rgba) => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };

  /** Les règles du dialogue, sans les commentaires qui précèdent leurs sélecteurs. */
  const plainRules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    body: m[2],
  }));

  /** La dernière déclaration de `property` dans les règles qui nomment exactement ce sélecteur. */
  const declared = (selector: string, property: string) => {
    const pattern = new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;]+);`, 'g');
    const values = plainRules
      .filter((r) => r.selectors.includes(selector))
      .flatMap((r) => [...r.body.matchAll(pattern)].map((m) => m[1].trim()));
    return values.at(-1);
  };

  const base = '.confirm-dialog-btn-confirm';
  const states = [
    { name: 'par défaut', text: [base], background: [base] },
    { name: 'par défaut, survolé', text: [base], background: [`${base}:hover`, base] },
    { name: 'en danger', text: [`${base}.is-danger`, base], background: [`${base}.is-danger`, base] },
    {
      name: 'en danger, survolé',
      text: [`${base}.is-danger`, base],
      background: [`${base}.is-danger:hover`, `${base}.is-danger`, base],
    },
  ];
  const first = (selectors: string[], property: string) =>
    selectors.map((s) => declared(s, property)).find((v) => v !== undefined) ?? 'transparent';

  it('atteint 4,5:1 sur le panneau, dans les deux thèmes, au repos comme au survol', () => {
    const panelValue = declared('.confirm-dialog', 'background-color');
    expect(panelValue).toBeDefined();
    const below: string[] = [];
    for (const [theme, tokens] of Object.entries(themes)) {
      const panel = resolve(panelValue ?? '', tokens);
      for (const state of states) {
        const background = over(resolve(first(state.background, 'background-color'), tokens), panel);
        const text = over(resolve(first(state.text, 'color'), tokens), background);
        const ratio = contrast(text, background);
        if (ratio < AA_NORMAL_TEXT) below.push(`${theme}, ${state.name} : ${ratio.toFixed(2)}:1`);
      }
    }
    expect(below).toEqual([]);
  });
});
