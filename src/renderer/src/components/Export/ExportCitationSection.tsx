import React, { useEffect, useState } from 'react';

/**
 * Per-export CSL citation options.
 *
 * When `useEngine` is true, the main-process export services run the
 * in-process `CitationEngine` pipeline: `[@key]` markers become numbered
 * footnotes and a bibliography is appended. When false, markers are left
 * untouched (legacy behavior).
 */
export interface ExportCitationValue {
  useEngine: boolean;
  style: string;
  locale: string;
}

interface Props {
  value: ExportCitationValue;
  onChange: (next: ExportCitationValue) => void;
  disabled?: boolean;
}

interface StyleEntry {
  id: string;
  label: string;
}

const FALLBACK_STYLE = 'chicago-note-bibliography';
const FALLBACK_LOCALE = 'fr-FR';

/**
 * Loads the persisted workspace default `{ citation: { style, locale } }`
 * and produces an initial `ExportCitationValue`. `useEngine` defaults to true
 * when a style is configured — historians who bothered to pick a style
 * almost always want their notes formatted.
 */
export async function loadDefaultCitationValue(): Promise<ExportCitationValue> {
  try {
    const saved = await window.electron.config.get('citation');
    if (saved && typeof saved === 'object') {
      const style = typeof saved.style === 'string' ? saved.style : FALLBACK_STYLE;
      const locale = typeof saved.locale === 'string' ? saved.locale : FALLBACK_LOCALE;
      return { useEngine: typeof saved.style === 'string', style, locale };
    }
  } catch {
    // Non-fatal; fall through.
  }
  return { useEngine: false, style: FALLBACK_STYLE, locale: FALLBACK_LOCALE };
}

export const ExportCitationSection: React.FC<Props> = ({ value, onChange, disabled }) => {
  const [styles, setStyles] = useState<StyleEntry[]>([]);
  const [locales, setLocales] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.electron.citation.listStyles();
        if (!cancelled && s?.success && Array.isArray(s.styles)) setStyles(s.styles);
        const l = await window.electron.citation.listLocales();
        if (!cancelled && l?.success && Array.isArray(l.locales)) setLocales(l.locales);
      } catch {
        // Non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleEngine = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...value, useEngine: e.target.checked });
  };

  return (
    <div
      className="form-field"
      data-testid="export-citation-section"
      style={{
        padding: '0.75rem',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        marginBottom: '1rem',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          color: 'var(--text-primary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={value.useEngine}
          onChange={toggleEngine}
          disabled={disabled}
          aria-label="Use CSL citation engine"
          data-testid="export-citation-toggle"
        />
        <span>Formater les citations avec CSL (Chicago, MLA…)</span>
      </label>

      {value.useEngine && (
        <div
          style={{
            marginTop: '0.75rem',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.75rem',
          }}
        >
          <div>
            <label htmlFor="export-citation-style" style={{ color: 'var(--text-secondary)' }}>
              Style
            </label>
            <select
              id="export-citation-style"
              aria-label="Citation style"
              value={value.style}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, style: e.target.value })}
            >
              {styles.length === 0 && <option value={value.style}>{value.style}</option>}
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="export-citation-locale" style={{ color: 'var(--text-secondary)' }}>
              Locale
            </label>
            <select
              id="export-citation-locale"
              aria-label="Citation locale"
              value={value.locale}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, locale: e.target.value })}
            >
              {locales.length === 0 && <option value={value.locale}>{value.locale}</option>}
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <p
        style={{
          marginTop: '0.5rem',
          marginBottom: 0,
          fontSize: '0.8125rem',
          color: 'var(--text-tertiary)',
        }}
      >
        Les marqueurs <code>[@key]</code> deviendront des notes de bas de page numérotées et la
        bibliographie sera ajoutée à la fin.
      </p>
    </div>
  );
};
