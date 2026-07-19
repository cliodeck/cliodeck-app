import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useEditorStore } from '../../stores/editorStore';
import { useManuscriptStore } from '../../stores/manuscriptStore';
import {
  searchManuscript,
  type SearchOutcome,
  type SearchableDocument,
} from '../../services/manuscript-search';
import { logger } from '../../utils/logger';
import './ManuscriptSearch.css';

/**
 * Panneau « chercher dans le livre » (audit item 21).
 *
 * `Cmd+F` reste la recherche du chapitre ouvert — celle de CodeMirror, plus
 * riche (remplacement, expressions régulières). Ce panneau répond à l'autre
 * besoin : retrouver un nom propre à travers tout un manuscrit sans ouvrir
 * les chapitres un à un.
 *
 * Le texte vient de `manuscriptStore.readManuscript()`, donc le chapitre
 * ouvert est lu dans l'éditeur vivant : une occurrence tapée il y a dix
 * secondes et non sauvegardée est trouvable.
 */

interface Props {
  onClose: () => void;
}

export const ManuscriptSearch: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((s) => s.currentProject);
  const chapters = useProjectStore((s) => s.chapters);
  const setCurrentChapter = useProjectStore((s) => s.setCurrentChapter);
  const loadFile = useEditorStore((s) => s.loadFile);

  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = useCallback(async () => {
    const term = query.trim();
    if (!term) {
      setOutcome(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const docs = await useManuscriptStore.getState().readManuscript();
      const searchable: SearchableDocument[] = docs.map((doc) => ({
        chapterId: doc.chapter.id,
        title: doc.chapter.title,
        filePath: doc.chapter.filePath,
        content: doc.content,
        live: doc.live,
      }));
      setOutcome(searchManuscript(searchable, term));
    } catch (err) {
      logger.error('ManuscriptSearch', err);
      setError(t('search.error'));
      setOutcome(null);
    } finally {
      setBusy(false);
    }
  }, [query, t]);

  /** Ouvre le chapitre porteur si besoin, puis pose le curseur sur la ligne. */
  const goTo = useCallback(
    async (chapterId: string, line: number) => {
      const chapter = chapters.find((c) => c.id === chapterId);
      if (!chapter || !currentProject) return;
      try {
        const target = `${currentProject.path}/${chapter.filePath}`;
        if (useEditorStore.getState().filePath !== target) {
          // `loadFile` sauvegarde le chapitre sortant avant de charger.
          await loadFile(target);
          setCurrentChapter(chapter.id);
        }
        useEditorStore.getState().editorFacade?.revealLine(line);
      } catch (err) {
        logger.error('ManuscriptSearch', err);
        setError(t('search.error'));
      }
    },
    [chapters, currentProject, loadFile, setCurrentChapter, t]
  );

  return (
    <div className="manuscript-search">
      <div className="manuscript-search__header">
        <span className="manuscript-search__title">{t('search.title')}</span>
        <button
          type="button"
          className="manuscript-search__close"
          onClick={onClose}
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <form
        className="manuscript-search__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          ref={inputRef}
          type="search"
          className="manuscript-search__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
        />
        <button
          type="submit"
          className="manuscript-search__submit"
          disabled={busy || !query.trim()}
          title={t('search.run')}
        >
          <Search size={14} strokeWidth={1.5} />
        </button>
      </form>

      <div className="manuscript-search__body">
        {busy && <p className="manuscript-search__note">{t('search.searching')}</p>}
        {error && <p className="manuscript-search__note manuscript-search__note--error">{error}</p>}

        {!busy && outcome && outcome.total === 0 && (
          <p className="manuscript-search__note">
            {t('search.noResults', { query: outcome.query })}
          </p>
        )}

        {!busy && outcome && outcome.total > 0 && (
          <>
            <p className="manuscript-search__summary">
              {t('search.summary', {
                count: outcome.total,
                chapters: outcome.chapters.length,
              })}
            </p>
            {outcome.chapters.map((chapter) => (
              <section key={chapter.chapterId} className="manuscript-search__chapter">
                <h4 className="manuscript-search__chapter-title">
                  {chapter.title}
                  <span className="manuscript-search__count">{chapter.matches.length}</span>
                </h4>
                <ul className="manuscript-search__list">
                  {chapter.matches.map((match) => (
                    <li key={`${chapter.chapterId}-${match.from}`}>
                      <button
                        type="button"
                        className="manuscript-search__hit"
                        onClick={() => void goTo(chapter.chapterId, match.line)}
                        title={t('search.goToLine', { line: match.line })}
                      >
                        <span className="manuscript-search__line">{match.line}</span>
                        <span className="manuscript-search__excerpt">
                          {match.before}
                          <mark>{match.match}</mark>
                          {match.after}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {chapter.truncated && (
                  <p className="manuscript-search__note">{t('search.truncated')}</p>
                )}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
};
