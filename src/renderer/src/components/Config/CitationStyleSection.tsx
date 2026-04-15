import React, { useEffect, useState, useCallback } from 'react';
import { CollapsibleSection } from '../common/CollapsibleSection';

/**
 * Citation style selector (CSL / citeproc-js).
 *
 * - Lists styles + locales from `window.electron.citation.{listStyles,listLocales}`.
 * - Persists `{ citation: { style, locale } }` via `window.electron.config.set`.
 * - Renders a live preview (one note + one bibliography entry) using the first
 *   citation from the currently-loaded bibliography, if any. When no entry is
 *   available the preview area is hidden — `citation:preview` requires a bibKey.
 */
interface StyleEntry {
  id: string;
  label: string;
}

export interface CitationConfig {
  style: string;
  locale: string;
}

const DEFAULT_CITATION: CitationConfig = {
  style: 'chicago-note-bibliography',
  locale: 'en-US',
};

export const CitationStyleSection: React.FC = () => {
  const [styles, setStyles] = useState<StyleEntry[]>([]);
  const [locales, setLocales] = useState<string[]>([]);
  const [style, setStyle] = useState<string>(DEFAULT_CITATION.style);
  const [locale, setLocale] = useState<string>(DEFAULT_CITATION.locale);
  const [previewFootnote, setPreviewFootnote] = useState<string>('');
  const [previewBibliography, setPreviewBibliography] = useState<string>('');
  const [previewError, setPreviewError] = useState<string>('');
  const [previewKey, setPreviewKey] = useState<string>('');

  // Initial load of styles/locales + persisted config.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.electron.citation.listStyles();
        if (!cancelled && s?.success && Array.isArray(s.styles)) {
          setStyles(s.styles);
        }
        const l = await window.electron.citation.listLocales();
        if (!cancelled && l?.success && Array.isArray(l.locales)) {
          setLocales(l.locales);
        }
        const saved = await window.electron.config.get('citation');
        if (!cancelled && saved && typeof saved === 'object') {
          if (typeof saved.style === 'string') setStyle(saved.style);
          if (typeof saved.locale === 'string') setLocale(saved.locale);
        }
        // Try to find a candidate bibKey from the currently-loaded biblio.
        try {
          const resp = await window.electron.bibliography.search('');
          const first = resp?.citations?.[0];
          if (!cancelled && first?.key) setPreviewKey(first.key as string);
        } catch {
          // Non-fatal: preview just stays empty.
        }
      } catch (err) {
        console.error('[CitationStyleSection] init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: CitationConfig) => {
    try {
      await window.electron.config.set('citation', next);
    } catch (err) {
      console.error('[CitationStyleSection] failed to persist config:', err);
    }
  }, []);

  // Refresh preview whenever (style, locale, previewKey) change.
  useEffect(() => {
    if (!previewKey || !style || !locale) {
      setPreviewFootnote('');
      setPreviewBibliography('');
      setPreviewError('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electron.citation.preview(previewKey, style, locale);
        if (cancelled) return;
        if (res?.success) {
          setPreviewFootnote(res.footnote ?? '');
          setPreviewBibliography(res.bibliography ?? '');
          setPreviewError('');
        } else {
          setPreviewError(res?.error ?? 'Preview failed');
        }
      } catch (err) {
        if (!cancelled) setPreviewError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [style, locale, previewKey]);

  const onStyleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setStyle(next);
    void persist({ style: next, locale });
  };

  const onLocaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setLocale(next);
    void persist({ style, locale: next });
  };

  return (
    <CollapsibleSection title="Citation style" defaultExpanded={false}>
      <div className="config-section">
        <div className="config-section-content">
          <div className="config-field">
            <label className="config-label" htmlFor="citation-style-select">
              Style
            </label>
            <select
              id="citation-style-select"
              aria-label="Citation style"
              className="config-select"
              value={style}
              onChange={onStyleChange}
            >
              {styles.length === 0 && <option value={style}>{style}</option>}
              {styles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="config-field">
            <label className="config-label" htmlFor="citation-locale-select">
              Locale
            </label>
            <select
              id="citation-locale-select"
              aria-label="Citation locale"
              className="config-select"
              value={locale}
              onChange={onLocaleChange}
            >
              {locales.length === 0 && <option value={locale}>{locale}</option>}
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>

          {previewKey && (
            <div className="config-field">
              <label className="config-label">Preview</label>
              {previewError ? (
                <div className="config-description" style={{ color: 'var(--color-danger)' }}>
                  {previewError}
                </div>
              ) : (
                <div className="config-description">
                  <div
                    data-testid="citation-preview-footnote"
                    dangerouslySetInnerHTML={{ __html: previewFootnote }}
                  />
                  <div
                    data-testid="citation-preview-bibliography"
                    style={{ marginTop: 8 }}
                    dangerouslySetInnerHTML={{ __html: previewBibliography }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
};
