import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { computeDocumentStats } from '@/editor/document-stats';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useManuscriptStore, currentRelativePath } from '../../stores/manuscriptStore';
import './DocumentStats.css';

/**
 * Barre de statistiques du document (28 px sous l'éditeur).
 *
 * Comptages par arbre Lezer (`@/editor/document-stats`) : les `[@…]`/`[^n]`
 * des blocs de code ne comptent pas, les notes sont des paires appel/définition
 * distinctes, les citations sont les clés (`[@a; @b]` = 2). Alimentée par le
 * `content` du store, déjà debouncé (300 ms) par la sync CM6.
 *
 * **Livre (Phase 3)** : le chapitre courant est calculé en direct, le total
 * de l'ouvrage vient du dérivé mis en cache par `manuscriptStore` (le
 * chapitre ouvert y étant substitué par sa valeur vivante). Le manuscrit
 * entier n'est donc JAMAIS re-parsé à la frappe — mesure du bilan : 165 ms
 * pour 400 000 mots.
 */
export const DocumentStats: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const { content } = useEditorStore();
  const isBook = useProjectStore((s) => s.currentProject?.type === 'book');
  const chapters = useProjectStore((s) => s.chapters);
  const info = useManuscriptStore((s) => s.info);

  const stats = useMemo(() => computeDocumentStats(content), [content]);
  const fmt = (n: number): string => n.toLocaleString(i18n.language);

  // Total d'ouvrage : somme des dérivés, valeur vivante pour le chapitre ouvert.
  const bookWords = useMemo(() => {
    if (!isBook || chapters.length < 2) return null;
    const openRel = currentRelativePath();
    let total = 0;
    for (const chapter of chapters) {
      if (chapter.missing) continue;
      total +=
        chapter.filePath === openRel
          ? stats.words
          : (info[chapter.filePath]?.stats.words ?? 0);
    }
    return total;
  }, [isBook, chapters, info, stats.words]);

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
      {bookWords !== null && (
        <div className="stat-item stat-item--book" title={t('stats.bookTotalHint')}>
          <span className="stat-label">{t('stats.bookWords')}</span>
          <span className="stat-value">{fmt(bookWords)}</span>
        </div>
      )}
    </div>
  );
};
