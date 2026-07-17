import { Prec } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import type { PendingProposal, ProposalsField } from './state';
import type { ProposalLabels } from './types';

/**
 * Affichage des propositions : l'original marqué (barré, teinte danger),
 * le texte proposé en regard dans un encart (teinte accent) avec les
 * actions ✓ / ✗ / ✎. DOM construit à la main — jamais d'innerHTML avec du
 * contenu du document.
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

    if (this.proposal.ui === 'note') this.renderNote(box, view);
    else if (this.proposal.ui === 'modify') this.renderModify(box, view);
    else this.renderButtons(box, view);

    return box;
  }

  private renderButtons(box: HTMLElement, view: EditorView): void {
    if (this.proposal.proposed !== '') {
      const text = document.createElement('span');
      text.className = 'cm-proposal-text';
      text.textContent = this.proposal.proposed;
      box.appendChild(text);
    }
    const btn = (
      symbol: string,
      title: string,
      onClick: () => void
    ): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-proposal-btn';
      b.textContent = symbol;
      b.title = title;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onClick();
      });
      box.appendChild(b);
    };
    btn('✓', this.labels.accept, () =>
      this.handlers.accept(view, this.proposal.id)
    );
    btn('✗', this.labels.reject, () =>
      this.handlers.reject(view, this.proposal.id)
    );
    btn('✎', this.labels.modify, () =>
      this.handlers.startModify(view, this.proposal.id)
    );
  }

  private renderNote(box: HTMLElement, view: EditorView): void {
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
    box.appendChild(input);
    requestAnimationFrame(() => input.focus());
  }

  private renderModify(box: HTMLElement, view: EditorView): void {
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
    box.appendChild(area);

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
    box.appendChild(apply);
    box.appendChild(cancel);
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
  '.cm-proposal-box': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    margin: '0 2px',
    padding: '0 6px',
    borderRadius: '4px',
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
    fontSize: '92%',
  },
  '.cm-proposal-text': { color: 'var(--text-primary)' },
  '.cm-proposal-btn': {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '0 2px',
    color: 'var(--text-secondary)',
    fontSize: 'inherit',
  },
  '.cm-proposal-btn:hover': { color: 'var(--color-accent)' },
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
