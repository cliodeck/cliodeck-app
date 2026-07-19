/**
 * Chaîne slides côté main (chantier « même éditeur ») : frontmatter YAML =
 * source de config reveal (strippé du rendu), découpage partagé
 * (src/editor/slides.ts) pour preview ET export, preview rendue par marked
 * avec ancres de synchro data-aslide.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: class {},
}));

import {
  extractDeck,
  generatePreviewHtml,
  resolveDeckConfig,
  type RevealJsExportOptions,
} from '../revealjs-export.js';

const OPTS: RevealJsExportOptions = { projectPath: '/tmp/p', content: '' };

const DECK = `---
title: Danzig 1932
author: Frédéric Clavert
theme: sky
transition: fade
---

# Section une

Contenu de la première slide.

---

## Verticale

Note:
Rappeler la chronologie.

---

\`\`\`markdown
---
# pas une slide : bloc de code
\`\`\`
`;

describe('extractDeck — frontmatter = config reveal', () => {
  it('strippe le frontmatter et lit les métadonnées valides', () => {
    const { body, meta, deck } = extractDeck(DECK);
    expect(meta).toMatchObject({
      title: 'Danzig 1932',
      author: 'Frédéric Clavert',
      theme: 'sky',
      transition: 'fade',
    });
    expect(body.startsWith('\n# Section une')).toBe(true);
    expect(deck.frontmatter).not.toBeNull();
  });

  it("un deck ouvrant sur --- séparateur n'est pas un frontmatter", () => {
    const { meta, deck } = extractDeck('---\n\n# Première slide\n');
    expect(deck.frontmatter).toBeNull();
    expect(meta).toEqual({});
  });

  it('rejette un thème/transition inconnus sans jeter', () => {
    const { meta } = extractDeck('---\ntitle: X\ntheme: vaporwave\ntransition: teleport\n---\n\n# S\n');
    expect(meta.title).toBe('X');
    expect(meta.theme).toBeUndefined();
    expect(meta.transition).toBeUndefined();
  });
});

describe('resolveDeckConfig — précédences', () => {
  it('frontmatter > reveal-config pour theme/transition', () => {
    const r = resolveDeckConfig(DECK, { ...OPTS, config: { theme: 'black', transition: 'zoom' } });
    expect(r.theme).toBe('sky');
    expect(r.transition).toBe('fade');
  });

  it('saisie du modal > frontmatter pour titre/auteur ; frontmatter comble les vides', () => {
    const explicit = resolveDeckConfig(DECK, { ...OPTS, metadata: { title: 'Mon titre', author: 'A. Autre' } });
    expect(explicit.title).toBe('Mon titre');
    expect(explicit.author).toBe('A. Autre');
    const fallback = resolveDeckConfig(DECK, { ...OPTS, metadata: { title: 'Mon titre' } });
    expect(fallback.author).toBe('Frédéric Clavert');
  });
});

describe('generatePreviewHtml — vraie grammaire, rendu de la slide active', () => {
  // La CSP de l'app (`script-src 'self'`) interdit tout script inline, iframe
  // srcDoc comprise : la preview est STATIQUE et ne rend que la slide du
  // curseur ; la synchro se fait par re-génération côté renderer.
  const html = generatePreviewHtml(DECK, OPTS);

  it('ne rend pas le frontmatter comme une slide', () => {
    expect(html).not.toContain('title: Danzig 1932');
  });

  it('rend le markdown côté main (marked), sans mini-moteur data-md', () => {
    expect(html).toContain('<h1>Section une</h1>');
    expect(html).not.toContain('data-md=');
  });

  it("ne contient aucun script inline (CSP de l'app)", () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick=');
  });

  it('affiche la slide demandée et son rang', () => {
    expect(html).toContain('data-aslide="0"');
    expect(html).toContain('1 / 3');
    const second = generatePreviewHtml(DECK, OPTS, 1);
    expect(second).toContain('data-aslide="1"');
    expect(second).toContain('Verticale');
    expect(second).toContain('2 / 3');
  });

  it('sépare les notes présentateur du corps', () => {
    const withNotes = generatePreviewHtml(DECK, OPTS, 1);
    expect(withNotes).toContain('Rappeler la chronologie.');
    expect(withNotes).toContain('slide-notes');
  });

  it('un --- dans un bloc de code ne crée pas de slide', () => {
    // Le compteur porte le TOTAL du découpage : 3 slides réelles, pas 4.
    expect(html).toContain('1 / 3');
  });

  it('groupe H1 + ## suivants : sous-découpe partageant le même aIndex', () => {
    const grouped = generatePreviewHtml('# S\n\ntexte\n\n## V1\n\nplus\n', OPTS);
    // Deux slides reveal (H1 puis ##) issues du MÊME segment partagé 0.
    expect(grouped).toContain('data-aslide="0"');
    expect(grouped).toContain('1 / 2');
  });
});
