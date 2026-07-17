import { EditorView } from '@codemirror/view';

/**
 * Styles du rendu live — exclusivement sur les tokens CSS de ClioDeck
 * (src/renderer/src/index.css), teintes via color-mix : jamais de couleur
 * en dur (convention CLAUDE.md). Tailles de titres en em relatifs.
 */
export const liveRenderTheme = EditorView.baseTheme({
  '.cm-live-h': { fontWeight: '700', lineHeight: '1.3' },
  '.cm-live-h1': { fontSize: '1.7em' },
  '.cm-live-h2': { fontSize: '1.45em' },
  '.cm-live-h3': { fontSize: '1.25em' },
  '.cm-live-h4': { fontSize: '1.12em' },
  '.cm-live-h5': { fontSize: '1.04em' },
  '.cm-live-h6': { fontSize: '1em', color: 'var(--text-secondary)' },

  '.cm-live-inline-code': {
    background: 'color-mix(in srgb, var(--text-primary) 9%, transparent)',
    borderRadius: '3px',
    padding: '0 3px',
  },

  '.cm-live-link': {
    color: 'var(--color-accent)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },

  '.cm-live-image-alt': {
    color: 'var(--text-secondary)',
    fontStyle: 'italic',
  },

  '.cm-live-quote': {
    borderLeft: '3px solid var(--color-accent)',
    paddingLeft: '0.75em',
    color: 'var(--text-secondary)',
    background: 'color-mix(in srgb, var(--color-accent) 4%, transparent)',
  },

  '.cm-live-code': {
    background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
  },

  '.cm-live-hr': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
    borderTop: '1px solid var(--border-color)',
  },

  '.cm-live-task': {
    accentColor: 'var(--color-accent)',
    marginRight: '0.4em',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },

  '.cm-live-image img': {
    display: 'block',
    maxWidth: 'min(100%, 480px)',
    margin: '4px 0',
    borderRadius: '4px',
  },

  '.cm-live-image-missing': {
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
});
