import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeDocumentStats } from '@/editor/document-stats';
import { useEditorStore } from '../../stores/editorStore';
import './DocumentStats.css';

/**
 * Barre de statistiques du document (28 px sous l'éditeur).
 *
 * Comptages par arbre Lezer (`@/editor/document-stats`) : les `[@…]`/`[^n]`
 * des blocs de code ne comptent pas, les notes sont des paires appel/définition
 * distinctes, les citations sont les clés (`[@a; @b]` = 2). Alimentée par le
 * `content` du store, déjà debouncé (300 ms) par la sync CM6.
 */
export const DocumentStats: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const { content } = useEditorStore();

  const stats = useMemo(() => computeDocumentStats(content), [content]);
  const fmt = (n: number): string => n.toLocaleString(i18n.language);

  const items: Array<{ key: string; value: number }> = [
    { key: 'words', value: stats.words },
    { key: 'chars', value: stats.chars },
    { key: 'charsWithSpaces', value: stats.charsWithSpaces },
    { key: 'paragraphs', value: stats.paragraphs },
    { key: 'citations', value: stats.citations },
    { key: 'footnotes', value: stats.footnotes },
  ];

  return (
    <div className="document-stats">
      {items.map(({ key, value }) => (
        <div className="stat-item" key={key}>
          <span className="stat-label">{t(`stats.${key}`)}</span>
          <span className="stat-value">{fmt(value)}</span>
        </div>
      ))}
    </div>
  );
};
