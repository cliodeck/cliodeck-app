import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, X } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore';
import { useSlidesStore } from '../../stores/slidesStore';

const DEBOUNCE_MS = 600;

export const SlidePreviewPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { editorFacade, content } = useEditorStore();
  const { closePreview } = useSlidesStore();

  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPreview = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electron.slides.getPreviewHtml({ content: text });
      if (result.success && result.html) {
        setPreviewHtml(result.html);
      } else {
        setError(result.error ?? t('slides.preview.error'));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('slides.preview.error'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // Initial load
  useEffect(() => {
    if (content) loadPreview(content);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced reload on content change
  useEffect(() => {
    if (!editorFacade) return;

    const unsubscribe = editorFacade.onContentChange((text) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => loadPreview(text), DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [editorFacade, loadPreview]);

  return (
    <div className="slide-preview-panel">
      <div className="spv-header">
        <span className="spv-title">{t('slides.preview.title')}</span>
        <div className="spv-actions">
          {isLoading && <RefreshCw size={13} className="spv-spinner" />}
          <button className="spv-close" onClick={closePreview} title={t('common.close')}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="spv-body">
        {error ? (
          <div className="spv-error">{error}</div>
        ) : (
          <iframe
            className="spv-iframe"
            srcDoc={previewHtml}
            sandbox="allow-scripts"
            title={t('slides.preview.title')}
          />
        )}
      </div>
    </div>
  );
};
