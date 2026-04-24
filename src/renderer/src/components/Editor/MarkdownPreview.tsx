import React, { useState, useEffect } from 'react';
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
  const { content } = useEditorStore();
  const [htmlContent, setHtmlContent] = useState<string>('');

  useEffect(() => {
    if (!content || content.trim().length === 0) {
      setHtmlContent('<p style="color: #888; font-style: italic;">Commencez à écrire pour voir la prévisualisation...</p>');
      return;
    }

    try {
      // marked(..., { async: false }) is typed as returning `string`; sanitize
      // before injection via dangerouslySetInnerHTML.
      const parsed = marked(content, { async: false });
      setHtmlContent(sanitizePreview(parsed));
    } catch (error) {
      console.error('Markdown parsing error:', error);
      setHtmlContent('<p style="color: #f48771;">Erreur de parsing markdown</p>');
    }
  }, [content]);

  return (
    <div className="markdown-preview">
      <div className="preview-content" dangerouslySetInnerHTML={{ __html: htmlContent }} />
    </div>
  );
};
