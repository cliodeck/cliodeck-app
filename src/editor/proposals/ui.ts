import { Prec } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type Rect,
} from '@codemirror/view';
import { Check, Pencil, Sparkles, X, createElement as createIcon, type IconNode } from 'lucide';
import type { PendingProposal, ProposalsField } from './state';
import type { ProposalLabels } from './types';

/**
 * Affichage des propositions : l'original marqué (barré, teinte danger),
 * le texte proposé en regard dans un encart (teinte accent, bordure gauche)
 * qui s'ouvre sur une barre : son nom, puis les actions accepter / rejeter /
 * modifier, chacune avec son icône lucide et son libellé. DOM construit à la
 * main — jamais d'innerHTML avec du contenu du document.
 */

export interface ProposalUiHandlers {
  accept: (view: EditorView, id: string) => boolean;
  reject: (view: EditorView, id: string) => boolean;
  submitRejection: (view: EditorView, id: string, note: string | null) => void;
  startModify: (view: EditorView, id: string) => void;
  cancelUi: (view: EditorView, id: string) => void;
  applyModified: (view: EditorView, id: string, final: string) => void;
}

class ProposalWidget extends WidgetType {
  constructor(
    private readonly proposal: PendingProposal,
    private readonly labels: ProposalLabels,
    private readonly handlers: ProposalUiHandlers
  ) {
    super();
  }

  override eq(other: ProposalWidget): boolean {
    return (
      other.proposal.id === this.proposal.id &&
      other.proposal.proposed === this.proposal.proposed &&
      other.proposal.ui === this.proposal.ui
    );
  }

  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-proposal-box';
    box.dataset.proposalId = this.proposal.id;

    // La barre d'abord : après une réponse de trente paragraphes, les actions tombaient sous le bas
    // de l'écran, et rien ne disait que ce texte n'était pas encore celui de l'auteur (BT1-1).
    const bar = document.createElement('span');
    bar.className = 'cm-proposal-bar';
    const heading = document.createElement('span');
    heading.className = 'cm-proposal-heading';
    heading.appendChild(createIcon(Sparkles, { width: 14, height: 14 }));
    heading.appendChild(document.createTextNode(this.labels.heading));
    bar.appendChild(heading);
    box.appendChild(bar);

    if (this.proposal.ui === 'note') this.renderNote(bar, view);
    else if (this.proposal.ui === 'modify') this.renderModify(box, bar, view);
    else this.renderButtons(box, bar, view);

    return box;
  }

  /**
   * Quand CodeMirror vise l'encart lui-même, sa position est sa barre, et c'est elle que
   * `scrollIntoView` amène à l'écran. Sinon ce serait l'encart entier : plus haut que l'écran, il
   * s'y montrait par le bas. CodeMirror le vise quand il est sur la ligne visuelle du tampon qui le
   * précède : toujours sans retour à la ligne, et avec, sur une ligne vide ou en début de ligne.
   * Au milieu d'un paragraphe, avec retour à la ligne, l'encart passe à la ligne suivante et
   * CodeMirror vise le texte de l'auteur : c'est alors la barre en tête qui met les boutons à
   * l'écran (`LineTile.resolveInline`, @codemirror/view). Voir docs/editor-proposals.md.
   */
  override coordsAt(dom: HTMLElement): Rect | null {
    return dom.querySelector('.cm-proposal-bar')?.getBoundingClientRect() ?? null;
  }

  private renderButtons(box: HTMLElement, bar: HTMLElement, view: EditorView): void {
    const btn = (
      icon: IconNode,
      label: string,
      title: string,
      onClick: () => void
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-proposal-btn';
      b.appendChild(createIcon(icon, { width: 14, height: 14 }));
      b.appendChild(document.createTextNode(label));
      // Le libellé long garde le raccourci (Tab, Échap) : au survol, et aux lecteurs d'écran.
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onClick();
      });
      bar.appendChild(b);
      return b;
    };
    btn(Check, this.labels.acceptShort, this.labels.accept, () =>
      this.handlers.accept(view, this.proposal.id)
    ).classList.add('cm-proposal-btn-accept');
    btn(X, this.labels.rejectShort, this.labels.reject, () =>
      this.handlers.reject(view, this.proposal.id)
    );
    btn(Pencil, this.labels.modifyShort, this.labels.modify, () =>
      this.handlers.startModify(view, this.proposal.id)
    );
    if (this.proposal.proposed !== '') {
      const text = document.createElement('span');
      text.className = 'cm-proposal-text';
      text.textContent = this.proposal.proposed;
      box.appendChild(text);
    }
  }

  private renderNote(bar: HTMLElement, view: EditorView): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-proposal-note';
    input.placeholder = this.labels.rejectionPrompt;
    let done = false;
    const submit = (note: string | null): void => {
      if (done) return;
      done = true;
      this.handlers.submitRejection(view, this.proposal.id, note);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit(input.value.trim() || null);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        submit(null);
      }
      e.stopPropagation();
    });
    // Non bloquant : cliquer ailleurs vaut « passer ».
    input.addEventListener('blur', () => submit(null));
    bar.appendChild(input);
    requestAnimationFrame(() => input.focus());
  }

  private renderModify(box: HTMLElement, bar: HTMLElement, view: EditorView): void {
    const area = document.createElement('textarea');
    area.className = 'cm-proposal-edit';
    area.value = this.proposal.proposed;
    area.rows = Math.min(6, this.proposal.proposed.split('\n').length + 1);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.handlers.applyModified(view, this.proposal.id, area.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.handlers.cancelUi(view, this.proposal.id);
      }
      e.stopPropagation();
    });

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'cm-proposal-btn';
    apply.textContent = this.labels.apply;
    apply.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.handlers.applyModified(view, this.proposal.id, area.value);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cm-proposal-btn';
    cancel.textContent = this.labels.cancel;
    cancel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.handlers.cancelUi(view, this.proposal.id);
    });
    bar.appendChild(apply);
    bar.appendChild(cancel);
    box.appendChild(area);
    requestAnimationFrame(() => area.focus());
  }
}

export function proposalDecorations(
  field: ProposalsField,
  labels: ProposalLabels,
  handlers: ProposalUiHandlers
) {
  return EditorView.decorations.from(field, (proposals): DecorationSet => {
    const ranges = [...proposals]
      .sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to)
      .flatMap((p) => {
        const out = [];
        if (p.range.to > p.range.from) {
          out.push(
            Decoration.mark({ class: 'cm-proposal-original' }).range(
              p.range.from,
              p.range.to
            )
          );
        }
        out.push(
          Decoration.widget({
            widget: new ProposalWidget(p, labels, handlers),
            side: 1,
          }).range(p.range.to)
        );
        return out;
      });
    return Decoration.set(ranges, true);
  });
}

/** Tab accepte / Échap rejette la proposition au curseur — sinon laisse passer. */
export function proposalKeymap(
  field: ProposalsField,
  handlers: ProposalUiHandlers
) {
  const at = (view: EditorView): PendingProposal | undefined => {
    const head = view.state.selection.main.head;
    return view.state
      .field(field)
      .find((p) => p.range.from <= head && head <= p.range.to);
  };
  return Prec.high(
    keymap.of([
      {
        key: 'Tab',
        run: (view) => {
          const p = at(view);
          return p ? handlers.accept(view, p.id) : false;
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          const p = at(view);
          return p ? handlers.reject(view, p.id) : false;
        },
      },
    ])
  );
}

/** À la destruction de la vue, les propositions en attente expirent. */
export function proposalExpiry(
  field: ProposalsField,
  onExpire: (proposal: PendingProposal) => void
) {
  return ViewPlugin.fromClass(
    class {
      constructor(private readonly view: EditorView) {}
      destroy(): void {
        for (const p of this.view.state.field(field)) onExpire(p);
      }
    }
  );
}

export const proposalTheme = EditorView.baseTheme({
  '.cm-proposal-original': {
    backgroundColor: 'color-mix(in srgb, var(--color-danger) 15%, transparent)',
    textDecoration: 'line-through',
    textDecorationColor:
      'color-mix(in srgb, var(--color-danger) 60%, transparent)',
  },
  // En colonne, la barre en tête : sa ligne de base est celle de l'encart, qui se range donc sur la
  // ligne de l'auteur, et le texte proposé descend dessous. La bordure gauche et la teinte le
  // distinguent du texte de l'auteur.
  '.cm-proposal-box': {
    display: 'inline-flex',
    flexDirection: 'column',
    gap: '4px',
    margin: '0 2px',
    padding: '2px 8px 4px',
    borderRadius: '4px',
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-accent) 45%, transparent)',
    borderLeft: '3px solid var(--color-accent)',
    fontSize: '92%',
  },
  // Large de son seul contenu : c'est sa boîte que le défilement montre. Étirée à la largeur du
  // texte, sans retour à la ligne, elle se montrait par son bord droit, boutons hors de l'écran.
  '.cm-proposal-bar': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: '6px',
  },
  '.cm-proposal-heading': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    marginRight: '4px',
    // Éclairci en sombre, assombri en clair : lisible sur la teinte de l'encart dans les deux thèmes.
    color: 'color-mix(in srgb, var(--color-accent) 70%, var(--text-primary))',
    fontWeight: '600',
  },
  '.cm-proposal-text': { color: 'var(--text-primary)' },
  '.cm-proposal-btn': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    cursor: 'pointer',
    padding: '0 6px',
    color: 'var(--text-primary)',
    font: 'inherit',
  },
  '.cm-proposal-btn:hover': {
    borderColor: 'var(--color-accent)',
    color: 'var(--color-accent)',
  },
  '.cm-proposal-btn-accept': {
    borderColor: 'var(--color-accent)',
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 22%, var(--bg-panel))',
  },
  '.cm-proposal-note, .cm-proposal-edit': {
    background: 'var(--bg-app)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '3px',
    font: 'inherit',
    padding: '1px 4px',
  },
  '.cm-proposal-edit': { minWidth: '260px', resize: 'vertical' },
});
