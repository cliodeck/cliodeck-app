import { hoverTooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { ResolvedCitation } from '../live-render';
import { citationAt, findDefinition, footnoteAt } from './footnote-lookup';
import type { ScholarlyLabels } from './types';

/**
 * Infobulles de survol (Phase 3b) : contenu de la définition sur un appel de
 * note, référence résolue (« Auteur (Année), Titre ») sur une citation.
 * DOM construit à la main — jamais d'innerHTML avec du contenu du document.
 */

interface TooltipOptions {
  resolveCitation?: (key: string) => ResolvedCitation | null;
  labels: ScholarlyLabels;
}

function tooltipDom(lines: { text: string; muted?: boolean }[]): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-scholarly-tooltip';
  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line.text;
    if (line.muted) p.className = 'cm-scholarly-tooltip-muted';
    dom.appendChild(p);
  }
  return dom;
}

export function scholarlyTooltips(options: TooltipOptions): Extension {
  return hoverTooltip((view, pos) => {
    const state = view.state;

    const fn = footnoteAt(state, pos);
    if (fn && fn.kind === 'reference') {
      const def = findDefinition(state, fn.label);
      const text = def
        ? state.sliceDoc(def.contentFrom, def.contentTo).trim()
        : '';
      return {
        pos: fn.from,
        end: fn.to,
        above: true,
        create: () => ({
          dom: tooltipDom(
            text
              ? [{ text }]
              : [{ text: options.labels.footnoteNoDefinition, muted: true }]
          ),
        }),
      };
    }

    const cit = citationAt(state, pos);
    if (cit) {
      const lines = cit.keys.map((key) => {
        const resolved = options.resolveCitation?.(key) ?? null;
        return resolved
          ? {
              text: `${resolved.author} (${resolved.year}), ${resolved.title}`,
            }
          : {
              text: `@${key} — ${options.labels.citationNotFound}`,
              muted: true,
            };
      });
      return {
        pos: cit.from,
        end: cit.to,
        above: true,
        create: () => ({ dom: tooltipDom(lines) }),
      };
    }

    return null;
  });
}
