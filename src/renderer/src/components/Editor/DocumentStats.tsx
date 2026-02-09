import React, { useMemo } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import './DocumentStats.css';

export const DocumentStats: React.FC = () => {
  const { content } = useEditorStore();

  const stats = useMemo(() => {
    // Count words (excluding markdown syntax)
    const plainText = content
      .replace(/^#{1,6}\s+/gm, '') // Remove headers
      .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
      .replace(/\*([^*]+)\*/g, '$1') // Remove italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links, keep text
      .replace(/`([^`]+)`/g, '$1') // Remove inline code
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/\[@[^\]]+\]/g, '') // Remove citations
      .trim();

    const words = plainText.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    // Count characters (without spaces)
    const charCount = plainText.replace(/\s/g, '').length;

    // Count characters (with spaces)
    const charWithSpacesCount = plainText.length;

    // Count paragraphs (non-empty lines)
    const paragraphs = content.split('\n\n').filter(p => p.trim().length > 0).length;

    // Count citations
    const citations = (content.match(/\[@[^\]]+\]/g) || []).length;

    // Count footnotes
    const footnotes = (content.match(/\[\^\d+\]/g) || []).length / 2; // Divided by 2 because each footnote appears twice

    return {
      wordCount,
      charCount,
      charWithSpacesCount,
      paragraphs,
      citations,
      footnotes,
    };
  }, [content]);

  return (
    <div className="document-stats">
      <div className="stat-item">
        <span className="stat-label">mots</span>
        <span className="stat-value">{stats.wordCount.toLocaleString()}</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">car.</span>
        <span className="stat-value">{stats.charCount.toLocaleString()}</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">car. esp.</span>
        <span className="stat-value">{stats.charWithSpacesCount.toLocaleString()}</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">par.</span>
        <span className="stat-value">{stats.paragraphs}</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">cit.</span>
        <span className="stat-value">{stats.citations}</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">notes</span>
        <span className="stat-value">{stats.footnotes}</span>
      </div>
    </div>
  );
};
