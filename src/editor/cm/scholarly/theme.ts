import { EditorView } from '@codemirror/view';

/**
 * Styles des comportements savants — tokens CSS ClioDeck uniquement,
 * teintes via color-mix (convention CLAUDE.md).
 */
export const scholarlyTheme = EditorView.baseTheme({
  // Infobulles (survol note / citation)
  '.cm-tooltip:has(.cm-scholarly-tooltip)': {
    backgroundColor: 'var(--bg-app)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
  },
  '.cm-scholarly-tooltip': {
    padding: '6px 10px',
    maxWidth: '420px',
    fontSize: '0.9em',
    color: 'var(--text-primary)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-scholarly-tooltip-muted': {
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
  },

  // Popup d'édition de note
  '.cm-tooltip:has(.cm-scholarly-popup)': {
    backgroundColor: 'var(--bg-app)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
  },
  '.cm-scholarly-popup': {
    padding: '8px',
    width: 'min(420px, 60vw)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  '.cm-scholarly-popup-title': {
    color: 'var(--color-accent)',
    fontSize: '0.85em',
    fontWeight: '600',
  },
  '.cm-scholarly-popup textarea': {
    width: '100%',
    resize: 'vertical',
    background: 'var(--bg-panel)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    padding: '6px',
    font: 'inherit',
    fontSize: '0.92em',
  },
  '.cm-scholarly-popup-actions': {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
  },
  '.cm-scholarly-popup-actions button': {
    background: 'var(--bg-panel)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: '0.88em',
  },
  '.cm-scholarly-popup-actions .cm-scholarly-popup-save': {
    background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
    borderColor: 'var(--color-accent)',
  },

  // Frontmatter
  '.cm-scholarly-frontmatter-folded': {
    color: 'var(--text-tertiary)',
    background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
    borderRadius: '4px',
    padding: '2px 8px',
    cursor: 'pointer',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  '.cm-scholarly-frontmatter-line': {
    background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
    color: 'var(--text-secondary)',
  },
  '.cm-scholarly-frontmatter-fold-btn': {
    background: 'transparent',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    marginLeft: '0.6em',
    padding: '0 6px',
    cursor: 'pointer',
    fontSize: '0.8em',
    verticalAlign: 'middle',
  },

  // Autocomplétion (tooltip CM6 par défaut, thémée ClioDeck)
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--bg-app)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)',
    color: 'var(--text-primary)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail': {
    color: 'var(--text-secondary)',
    fontStyle: 'normal',
    marginLeft: '0.8em',
  },
  '.cm-completionInfo': {
    backgroundColor: 'var(--bg-app)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
  },
});
