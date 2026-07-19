import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, X } from 'lucide-react';
import { parseSlides, slideIndexAtOffset } from '@/editor/slides';
import { useEditorStore } from '../../stores/editorStore';
import { useSlidesStore } from '../../stores/slidesStore';
import './SlidePreviewPanel.css';

const DEBOUNCE_MS = 600;

export const SlidePreviewPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const { editorFacade, content } = useEditorStore();
  const { closePreview } = useSlidesStore();

  const [previewHtml, setPreviewHtml] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Découpage courant pour la synchro curseur → slide ; mis à jour à chaque
  // changement de contenu (pas de re-render : refs seulement).
  const deckRef = useRef(parseSlides(content));
  const activeIndexRef = useRef(0);
  const lastTextRef = useRef(content);

  const loadPreview = useCallback(async (text: string) => {
    if (!text.trim()) return;
    lastTextRef.current = text;
    setIsLoading(true);
    setError(null);
    try {
      // La slide active est rendue CÔTÉ MAIN : la CSP de l'app interdit
      // tout script inline, iframe srcDoc comprise — la preview est
      // statique et se régénère quand le curseur change de slide.
      const result = await window.electron.slides.getPreviewHtml({
        content: text,
        activeSlideIndex: activeIndexRef.current,
      });
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
      deckRef.current = parseSlides(text);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => loadPreview(text), DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [editorFacade, loadPreview]);

  // Synchro curseur → slide active : re-génération de la preview quand le
  // curseur entre dans une autre slide (pas de script dans l'iframe, CSP).
  useEffect(() => {
    if (!editorFacade?.onSelectionChange) return;
    return editorFacade.onSelectionChange((offset) => {
      const index = slideIndexAtOffset(deckRef.current, offset);
      if (index === activeIndexRef.current) return;
      activeIndexRef.current = index;
      void loadPreview(lastTextRef.current);
    });
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
            ref={iframeRef}
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
