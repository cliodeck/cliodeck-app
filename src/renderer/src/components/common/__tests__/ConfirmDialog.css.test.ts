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
