import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import { useEditorStore } from '../../stores/editorStore';
import { sanitizePreview } from '../../utils/sanitize';
import './MarkdownPreview.css';

// Configure marked once, outside the component
marked.setOptions({
  breaks: true,
  gfm: true,
  async: false, // Force synchronous mode
});

export const MarkdownPreview: React.FC = () => {
  const { t } = useTranslation('common');
  const { content } = useEditorStore();
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    if (!content || content.trim().length === 0) {
      setHtmlContent(
        `<p style="color: var(--text-tertiary); font-style: italic;">${t('preview.empty')}</p>`
      );
      return;
    }

    try {
      // marked(..., { async: false }) is typed as returning `string`; sanitize
      // before injection via dangerouslySetInnerHTML.
      const parsed = marked(content, { async: false });
      setHtmlContent(sanitizePreview(parsed));
    } catch (error) {
      console.error('Markdown parsing error:', error);
      setHtmlContent(
        `<p style="color: var(--color-warning);">${t('preview.parseError')}</p>`
      );
    }
  }, [content, t]);

  return (
    <div className="markdown-preview">
      <div className="preview-content" dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </div>
  );
};
