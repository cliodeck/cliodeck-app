import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, X, RefreshCw, CheckCheck, ChevronDown } from 'lucide-react';
import { useEditorStore } from '../../stores/editorStore';
import { useSlidesStore } from '../../stores/slidesStore';
import { useBibliographyStore } from '../../stores/bibliographyStore';

type SourceType = 'document' | 'selection';

export const SlideGenerationPanel: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const { monacoEditor } = useEditorStore();
  const { closePanel } = useSlidesStore();
  const { citations } = useBibliographyStore();

  const [sourceType, setSourceType] = useState<SourceType>('document');
  const [language, setLanguage] = useState<string>(i18n.language?.split('-')[0] ?? 'fr');
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamedContent, setStreamedContent] = useState('');
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cleanupRef = useRef<(() => void)[]>([]);

  // Check if Monaco has a non-empty selection
  useEffect(() => {
    if (!monacoEditor) return;
    const selection = monacoEditor.getSelection();
    if (selection && !selection.isEmpty()) {
      setHasSelection(true);
      setSourceType('selection');
    }
  }, [monacoEditor]);

  // Auto-scroll the textarea as content streams in
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [streamedContent]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current.forEach((fn) => fn());
    };
  }, []);

  const getSourceText = (): string | null => {
    if (!monacoEditor) return null;
    if (sourceType === 'selection') {
      const selection = monacoEditor.getSelection();
      if (selection && !selection.isEmpty()) {
        return monacoEditor.getModel()?.getValueInRange(selection) ?? null;
      }
    }
    return monacoEditor.getValue() ?? null;
  };

  const handleGenerate = async () => {
    const text = getSourceText();
    if (!text?.trim()) {
      setError(t('slides.generate.noContent'));
      return;
    }

    setIsGenerating(true);
    setIsDone(false);
    setStreamedContent('');
    setError(null);

    // Remove previous listeners
    cleanupRef.current.forEach((fn) => fn());
    cleanupRef.current = [];

    // Setup stream listeners
    const removeStream = window.electron.slides.onStream((chunk) => {
      setStreamedContent((prev) => prev + chunk);
    });

    const removeDone = window.electron.slides.onStreamDone(({ cancelled }) => {
      setIsGenerating(false);
      setIsDone(!cancelled);
    });

    const removeError = window.electron.slides.onStreamError(({ error: errMsg }) => {
      setIsGenerating(false);
      setError(errMsg);
    });

    cleanupRef.current = [removeStream, removeDone, removeError];

    // Pass citations for bibliography-aware generation (Phase 4)
    const citationPayload = citations.length > 0
      ? citations.map((c) => ({ id: c.id, author: c.author, title: c.title, year: c.year }))
      : undefined;

    // Fire and forget — streaming comes via events
    window.electron.slides.generate({ text, language, citations: citationPayload }).catch((err: any) => {
      setIsGenerating(false);
      setError(err?.message ?? t('slides.generate.unknownError'));
    });
  };

  const handleCancel = async () => {
    await window.electron.slides.cancel();
    setIsGenerating(false);
  };

  const handleReplace = () => {
    if (!monacoEditor || !streamedContent) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const fullRange = model.getFullModelRange();
    monacoEditor.executeEdits('ai-replace', [{ range: fullRange, text: streamedContent }]);
    monacoEditor.focus();
    closePanel();
  };

  const handleAppend = () => {
    if (!monacoEditor || !streamedContent) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    monacoEditor.executeEdits('ai-append', [{
      range: { startLineNumber: lastLine, startColumn: lastCol, endLineNumber: lastLine, endColumn: lastCol },
      text: '\n\n' + streamedContent,
    }]);
    monacoEditor.focus();
    closePanel();
  };

  const handleReset = () => {
    setStreamedContent('');
    setIsDone(false);
    setError(null);
  };

  return (
    <div className="slide-generation-panel">
      <div className="sgp-header">
        <div className="sgp-title">
          <Sparkles size={16} strokeWidth={1.5} />
          <span>{t('slides.generate.title')}</span>
        </div>
        <button className="sgp-close" onClick={closePanel} title={t('common.close')}>
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="sgp-body">
        {/* Source selector */}
        <div className="sgp-field">
          <label className="sgp-label">{t('slides.generate.source')}</label>
          <div className="sgp-radio-group">
            <label className="sgp-radio">
              <input
                type="radio"
                value="document"
                checked={sourceType === 'document'}
                onChange={() => setSourceType('document')}
              />
              {t('slides.generate.fullDocument')}
            </label>
            <label className={`sgp-radio ${!hasSelection ? 'disabled' : ''}`}>
              <input
                type="radio"
                value="selection"
                checked={sourceType === 'selection'}
                onChange={() => setSourceType('selection')}
                disabled={!hasSelection}
              />
              {t('slides.generate.selection')}
            </label>
          </div>
        </div>

        {/* Language selector */}
        <div className="sgp-field">
          <label className="sgp-label">{t('slides.generate.promptLanguage')}</label>
          <div className="sgp-select-wrapper">
            <select
              className="sgp-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="fr">Français</option>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
            </select>
            <ChevronDown size={14} className="sgp-select-icon" />
          </div>
        </div>

        {/* Error */}
        {error && <div className="sgp-error">{error}</div>}

        {/* Streaming output */}
        {(streamedContent || isGenerating) && (
          <div className="sgp-output">
            <label className="sgp-label">{t('slides.generate.output')}</label>
            <textarea
              ref={textareaRef}
              className="sgp-textarea"
              value={streamedContent}
              readOnly
              rows={14}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="sgp-footer">
        {!isGenerating && !isDone && (
          <button className="sgp-btn sgp-btn-primary" onClick={handleGenerate}>
            <Sparkles size={14} strokeWidth={1.5} />
            {t('slides.generate.generate')}
          </button>
        )}

        {isGenerating && (
          <button className="sgp-btn sgp-btn-danger" onClick={handleCancel}>
            <X size={14} strokeWidth={1.5} />
            {t('slides.generate.cancel')}
          </button>
        )}

        {isDone && (
          <>
            <button className="sgp-btn sgp-btn-secondary" onClick={handleReset}>
              <RefreshCw size={14} strokeWidth={1.5} />
              {t('slides.generate.regenerate')}
            </button>
            <button className="sgp-btn sgp-btn-primary" onClick={handleReplace}>
              <CheckCheck size={14} strokeWidth={1.5} />
              {t('slides.generate.replace')}
            </button>
            <button className="sgp-btn sgp-btn-secondary" onClick={handleAppend}>
              {t('slides.generate.append')}
            </button>
          </>
        )}

        {!isGenerating && (
          <button className="sgp-btn sgp-btn-ghost" onClick={closePanel}>
            {t('common.close')}
          </button>
        )}
      </div>
    </div>
  );
};
