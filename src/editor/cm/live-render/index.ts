import type { Extension } from '@codemirror/state';
import { liveRenderPlugin } from './plugin';
import { imageWidgets, type ImageWidgetOptions } from './images';
import { liveRenderTheme } from './theme';
import type { LiveModelOptions } from './model';

export { computeLiveDecorations, findImages } from './model';
export type {
  LiveDeco,
  ImageSpec,
  LiveModelOptions,
  ResolvedCitation,
} from './model';
export { liveRenderRefresh } from './refresh';

export interface LiveRenderOptions
  extends ImageWidgetOptions,
    LiveModelOptions {}

/**
 * Rendu live façon Obsidian (plan CM6, Phase 2, enrichi Phase 3b) : masque la
 * syntaxe hors du nœud/de la ligne actifs, style titres/quotes/code, rend les
 * checkboxes cliquables, les règles horizontales, les aperçus d'images, les
 * appels de notes en exposant et les citations pandoc en pastilles (clés non
 * résolues soulignées) — sans jamais modifier le document (le test de
 * fidélité reste la loi).
 *
 * Les comportements savants (infobulles, popup d'édition de note,
 * navigation, autocomplétion, repli du frontmatter) vivent dans
 * `../scholarly/`.
 */
export function liveRender(options: LiveRenderOptions = {}): Extension {
  return [liveRenderPlugin(options), imageWidgets(options), liveRenderTheme];
}
