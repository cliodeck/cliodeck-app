import type { Extension } from '@codemirror/state';
import { scholarlyTooltips } from './tooltips';
import { footnotePopup, openFootnotePopup } from './footnote-popup';
import { scholarlyNav } from './nav';
import { citationCompletion } from './citation-autocomplete';
import { frontmatterFold, setFrontmatterFolded, detectFrontmatter } from './frontmatter';
import { scholarlyTheme } from './theme';
import { DEFAULT_LABELS, type ScholarlyOptions } from './types';

export type { CitationCandidate, ScholarlyLabels, ScholarlyOptions } from './types';
export { openFootnotePopup, setFrontmatterFolded, detectFrontmatter };
export {
  citationAt,
  findDefinition,
  findFirstReference,
  footnoteAt,
} from './footnote-lookup';

/**
 * Comportements savants de l'éditeur CM6 (plan CM6, Phase 3b) : infobulles
 * de notes et de citations, popup d'édition en place (Zettlr), navigation
 * bidirectionnelle appel↔définition, autocomplétion `@` alimentée par la
 * bibliographie de l'hôte, frontmatter replié.
 *
 * Le module ne connaît ni Zotero ni les stores ClioDeck : résolution et
 * candidats sont injectés par callbacks, libellés i18n par `labels`.
 */
export function scholarly(options: ScholarlyOptions = {}): Extension {
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  return [
    scholarlyTooltips({ resolveCitation: options.resolveCitation, labels }),
    footnotePopup(labels),
    scholarlyNav(),
    citationCompletion({ getCitations: options.getCitations, labels }),
    frontmatterFold(labels),
    scholarlyTheme,
  ];
}
