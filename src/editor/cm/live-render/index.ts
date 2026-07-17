import type { Extension } from '@codemirror/state';
import { liveRenderPlugin } from './plugin';
import { imageWidgets, type LiveRenderOptions } from './images';
import { liveRenderTheme } from './theme';

export type { LiveRenderOptions } from './images';
export { computeLiveDecorations, findImages } from './model';
export type { LiveDeco, ImageSpec } from './model';

/**
 * Rendu live façon Obsidian (plan CM6, Phase 2) : masque la syntaxe hors du
 * nœud/de la ligne actifs, style titres/quotes/code, rend les checkboxes
 * cliquables, les règles horizontales et les aperçus d'images — sans jamais
 * modifier le document (le test de fidélité reste la loi).
 *
 * Point d'intégration Phase 3b : les extensions Lezer footnotes/citations
 * ajouteront leurs propres nœuds ; leur rendu (exposant, pastille) se
 * branchera dans model.ts (nouveaux descripteurs) sans toucher au plugin.
 */
export function liveRender(options: LiveRenderOptions = {}): Extension {
  return [liveRenderPlugin, imageWidgets(options), liveRenderTheme];
}
