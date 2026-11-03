import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FilePlus,
  Link2,
  Settings2,
  X,
} from 'lucide-react';
import { BookSettingsModal } from './BookSettingsModal';
import type { Chapter, ResolvedChapter } from '@backend/types/book';
import { parseOutline, replaceLeadingHeading } from '@/editor/outline';
import { useProjectStore } from '../../stores/projectStore';
import { EditorFileError, openErrorKey, OutgoingSaveError, useEditorStore } from '../../stores/editorStore';
import { useManuscriptStore, currentRelativePath } from '../../stores/manuscriptStore';
import { useDialogStore } from '../../stores/dialogStore';
import { logger } from '../../utils/logger';
import './ChapterNavigator.css';

/**
 * Navigateur de chapitres (plan chapitres, Phase 2).
 *
 * Le manifeste fait foi pour l'ordre (arbitrage 7) ; le fichier porte le
 * texte. Deux principes tenus par ce panneau :
 *
 * - **on ne perd jamais de texte** : « retirer » sort du manifeste sans
 *   effacer le fichier, qui réapparaît aussitôt en « non rattaché » ;
 * - **la bascule est sûre** : elle passe par `loadFile`, qui sauvegarde le
 *   chapitre sortant avant de charger le suivant (verrou Phase 0).
 *
 * Réordonnancement par boutons plutôt que par glisser-déposer : l'ordre
 * d'un manuscrit se règle rarement, et doit être fiable au clavier comme à
 * la souris.
 *
 * **Renommage et titre `#`** — l'arbitrage 1 fait du `#` du fichier le
 * titre du chapitre à l'export ; le manifeste porte le titre de
 * navigation. Renommer mémorise le manifeste ET réécrit le `#` de tête
 * quand le chapitre est celui qui est ouvert (transaction annulable). Pour
 * un chapitre fermé on ne touche pas au fichier — on ne modifie jamais
 * sous les pieds de l'auteur un texte qu'il n'a pas devant lui ; la
 * divergence éventuelle est signalée par une pastille.
 *
 * **Plan (Phase 3)** — chaque chapitre déplie ses titres internes. Celui du
 * chapitre ouvert est vivant (recalculé sur le texte de l'éditeur) ; les
 * autres viennent du dérivé mis en cache par `manuscriptStore`. Le
 * découpage est celui de `parseOutline` (arbre Lezer), qui remplace aussi
 * l'ancien `replaceLeadingHeading` ligne à ligne : un `#` dans un bloc de
 * code ne peut plus être pris pour le titre du chapitre.
 */

/** Numéro affiché : seuls les chapitres du corps sont numérotés. */
function chapterNumbers(chapters: ResolvedChapter[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const chapter of chapters) {
    if ((chapter.kind ?? 'chapter') === 'chapter') {
      n += 1;
      numbers.set(chapter.id, n);
    }
  }
  return numbers;
}

/** Sans manifeste, un fichier vaut par son nom. */
function fallbackTitle(filePath: string): string {
  return filePath.replace(/^.*\//, '').replace(/\.md$/, '');
}

export const ChapterNavigator: React.FC = () => {
  const { t } = useTranslation('common');
  const currentProject = useProjectStore((s) => s.currentProject);
  const chapters = useProjectStore((s) => s.chapters);
  const unattachedFiles = useProjectStore((s) => s.unattachedFiles);
  const currentChapterId = useProjectStore((s) => s.currentChapterId);
  const setCurrentChapter = useProjectStore((s) => s.setCurrentChapter);
  const addChapter = useProjectStore((s) => s.addChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const reorderChapters = useProjectStore((s) => s.reorderChapters);
  const refreshChapters = useProjectStore((s) => s.refreshChapters);
  const loadFile = useEditorStore((s) => s.loadFile);
  const editorContent = useEditorStore((s) => s.content);
  const editorFilePath = useEditorStore((s) => s.filePath);
  const info = useManuscriptStore((s) => s.info);
  const refreshAll = useManuscriptStore((s) => s.refreshAll);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [working, setWorking] = useState(false);
  // Un changement de projet est en cours : ce panneau montre encore le projet qu'on
  // quitte, et plus rien ne doit écrire dans son manifeste.
  const isProjectLoading = useProjectStore((s) => s.loadState.kind === 'loading');
  const busy = working || isProjectLoading;
  /** `'new'` = saisie de création ; sinon identifiant du chapitre renommé. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Réglages de l'ouvrage (#24) — modale ouverte depuis l'en-tête.
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Événements rares seulement : liste de chapitres modifiée ou bascule.
  // Jamais à la frappe — le plan du chapitre ouvert est calculé en direct.
  useEffect(() => {
    void refreshAll();
  }, [chapters, editorFilePath, refreshAll]);

  const openRelPath = currentRelativePath();
  // Plan du chapitre ouvert : recalculé sur le texte vivant (déjà debouncé
  // à 300 ms par la synchronisation CM6).
  const liveOutline = useMemo(
    () => (openRelPath ? parseOutline(editorContent) : []),
    [openRelPath, editorContent]
  );

  const outlineFor = (chapter: ResolvedChapter) =>
    chapter.filePath === openRelPath
      ? liveOutline
      : (info[chapter.filePath]?.outline ?? []);

  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const goToLine = (chapter: ResolvedChapter, line: number): void => {
    if (chapter.filePath !== openRelPath) {
      void openChapter(chapter).then((opened) => {
        // Le chapitre vient d'être chargé : la façade est reconstruite.
        if (opened) useEditorStore.getState().editorFacade?.revealLine(line);
      });
      return;
    }
    useEditorStore.getState().editorFacade?.revealLine(line);
  };

  const numbers = chapterNumbers(chapters);

  const report = async (error: unknown, fallbackKey: string): Promise<void> => {
    logger.error('ChapterNavigator', error);
    // Le texte d'une lecture ou d'une écriture refusée vient du main, en anglais et avec le
    // chemin complet : il va au journal, pas à l'écran.
    const message =
      error instanceof EditorFileError || error instanceof OutgoingSaveError
        ? t(openErrorKey(error, fallbackKey))
        : error instanceof Error
          ? error.message
          : t(fallbackKey);
    await useDialogStore.getState().showAlert(message);
  };

  /** Rend vrai si le chapitre est bien celui qu'affiche désormais l'éditeur. */
  const openChapter = async (chapter: ResolvedChapter): Promise<boolean> => {
    if (!currentProject || chapter.missing) return false;
    // Pendant une renumérotation seulement : un export lit le manuscrit à son
    // départ et peut durer des minutes, on continue d'écrire pendant ce temps.
    if (useManuscriptStore.getState().renumbering) {
      await useDialogStore.getState().showAlert(t('book.renumberInProgress'));
      return false;
    }
    try {
      // `loadFile` sauvegarde le chapitre sortant avant de charger : c'est
      // ce qui rend la bascule sûre (verrou Phase 0).
      const outcome = await loadFile(`${currentProject.path}/${chapter.filePath}`);
      if (outcome.status === 'locked') {
        await useDialogStore.getState().showAlert(t(outcome.lock));
      }
      // Refusée ou dépassée, la bascule n'a pas eu lieu : le navigateur ne doit pas
      // annoncer un chapitre que l'éditeur ne montre pas.
      if (outcome.status !== 'replaced' && outcome.status !== 'unchanged') return false;
      setCurrentChapter(chapter.id);
      return true;
    } catch (error) {
      await report(error, 'toolbar.openError');
      return false;
    }
  };

  const startEditing = (key: string, initial: string): void => {
    setEditing(key);
    setDraft(initial);
  };

  const cancelEditing = (): void => {
    setEditing(null);
    setDraft('');
  };

  const submitEditing = async (): Promise<void> => {
    const title = draft.trim();
    const target = editing;
    cancelEditing();
    if (!title || !target || isProjectLoading) return;

    setWorking(true);
    try {
      if (target === 'new') {
        await addChapter(title);
      } else {
        await renameChapter(target, title);
      }
    } catch (error) {
      await report(error, target === 'new' ? 'book.addChapterError' : 'book.renameError');
    } finally {
      setWorking(false);
    }
  };

  const persistChapters = async (next: Chapter[]): Promise<void> => {
    if (!currentProject) throw new Error(t('book.noProject'));
    const result = await window.electron.project.saveChapters({
      projectPath: currentProject.path,
      chapters: next,
    });
    if (!result.success) throw new Error(result.error || t('book.reorderError'));
    await refreshChapters();
  };

  const renameChapter = async (chapterId: string, title: string): Promise<void> => {
    const chapter = chapters.find((c) => c.id === chapterId);
    if (!chapter) return;

    await persistChapters(
      chapters.map(({ missing: _m, ...c }) =>
        c.id === chapterId ? { ...c, title } : (c as Chapter)
      )
    );

    // Le `#` fait foi à l'export : on l'aligne quand le chapitre est sous
    // les yeux de l'auteur (édition annulable d'un simple Cmd+Z). Le chemin le dit, pas
    // `currentChapterId` : un chapitre annoncé n'est pas forcément celui qu'affiche
    // l'éditeur, et son titre s'écrirait alors dans un autre texte.
    if (chapter.filePath === currentRelativePath()) {
      const editor = useEditorStore.getState();
      const facade = editor.editorFacade;
      if (facade) {
        const updated = replaceLeadingHeading(facade.getValue(), title);
        if (updated !== facade.getValue()) facade.setValue(updated);
      }
    }
  };

  const handleRemove = async (chapter: ResolvedChapter): Promise<void> => {
    const confirmed = await useDialogStore
      .getState()
      .showConfirm(t('book.removeChapterConfirm', { title: chapter.title }));
    if (!confirmed) return;
    setWorking(true);
    try {
      await deleteChapter(chapter.id);
    } catch (error) {
      await report(error, 'book.removeChapterError');
    } finally {
      setWorking(false);
    }
  };

  const move = async (index: number, delta: number): Promise<void> => {
    const target = index + delta;
    if (target < 0 || target >= chapters.length) return;
    const next = [...chapters];
    [next[index], next[target]] = [next[target], next[index]];
    setWorking(true);
    try {
      await reorderChapters(next.map(({ missing: _m, ...c }) => c as Chapter));
    } catch (error) {
      await report(error, 'book.reorderError');
    } finally {
      setWorking(false);
    }
  };

  const handleAttach = async (filePath: string): Promise<void> => {
    setWorking(true);
    try {
      const suggested = unattachedFiles.find((f) => f.filePath === filePath);
      await persistChapters([
        ...chapters.map(({ missing: _m, ...c }) => c as Chapter),
        {
          id: `attached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: suggested?.suggestedTitle ?? fallbackTitle(filePath),
          filePath,
          order: chapters.length,
          kind: 'chapter',
        },
      ]);
    } catch (error) {
      await report(error, 'book.attachError');
    } finally {
      setWorking(false);
    }
  };

  const editorField = (
    <input
      ref={inputRef}
      className="chapter-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submitEditing();
        if (e.key === 'Escape') cancelEditing();
      }}
      onBlur={() => void submitEditing()}
      placeholder={t('book.titlePlaceholder')}
    />
  );

  return (
    <div className="chapter-navigator">
      <div className="chapter-navigator-header">
        <span className="chapter-navigator-count">
          {t('book.chapterCount', { count: chapters.length })}
        </span>
        <button
          className="chapter-navigator-action"
          onClick={() => setShowSettings(true)}
          disabled={!currentProject || isProjectLoading}
          title={t('book.settings.title')}
        >
          <Settings2 size={14} strokeWidth={1.5} />
        </button>
        <button
          className="chapter-navigator-action"
          onClick={() => startEditing('new', '')}
          disabled={busy || !currentProject}
          title={t('book.addChapter')}
        >
          <FilePlus size={14} strokeWidth={1.5} />
        </button>
      </div>

      <BookSettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {chapters.length === 0 && editing !== 'new' && (
        <p className="chapter-navigator-empty">{t('book.noChapters')}</p>
      )}

      <ul className="chapter-navigator-list">
        {chapters.map((chapter, index) => {
          const kind = chapter.kind ?? 'chapter';
          const number = numbers.get(chapter.id);
          const outline = outlineFor(chapter);
          // Le `#` de tête EST le titre du chapitre (arbitrage 1) : le plan
          // n'affiche que ce qui est SOUS lui.
          const inner = outline.filter((h) => h.level > 1);
          const isExpanded = expanded.has(chapter.id);
          return (
            <li
              key={chapter.id}
              className={[
                'chapter-item',
                // Le chapitre qui est devant l'auteur, pas le dernier cliqué : un tampon
                // sans titre ou un autre fichier du projet n'en sont aucun.
                chapter.id === currentChapterId && chapter.filePath === openRelPath ? 'active' : '',
                kind !== 'chapter' ? 'chapter-item--matter' : '',
                chapter.missing ? 'chapter-item--missing' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {editing === chapter.id ? (
                editorField
              ) : (
                <>
                  <button
                    className="chapter-item-open"
                    onClick={() => openChapter(chapter)}
                    onDoubleClick={() => startEditing(chapter.id, chapter.title)}
                    disabled={chapter.missing}
                    title={
                      chapter.missing
                        ? t('book.chapterMissing', { path: chapter.filePath })
                        : `${chapter.filePath} — ${t('book.renameHint')}`
                    }
                  >
                    <span className="chapter-number">
                      {chapter.missing ? (
                        <AlertTriangle size={12} strokeWidth={1.8} />
                      ) : (
                        (number ?? '—')
                      )}
                    </span>
                    <span className="chapter-title">{chapter.title}</span>
                  </button>
                  {inner.length > 0 && (
                    <button
                      className="chapter-outline-toggle"
                      onClick={() => toggleExpanded(chapter.id)}
                      title={t('book.outlineToggle', { count: inner.length })}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? (
                        <ChevronDown size={12} strokeWidth={1.6} />
                      ) : (
                        <ChevronRight size={12} strokeWidth={1.6} />
                      )}
                    </button>
                  )}
                  <span className="chapter-item-controls">
                    <button
                      onClick={() => move(index, -1)}
                      disabled={busy || index === 0}
                      title={t('book.moveUp')}
                    >
                      <ChevronUp size={13} strokeWidth={1.6} />
                    </button>
                    <button
                      onClick={() => move(index, 1)}
                      disabled={busy || index === chapters.length - 1}
                      title={t('book.moveDown')}
                    >
                      <ChevronDown size={13} strokeWidth={1.6} />
                    </button>
                    <button
                      onClick={() => handleRemove(chapter)}
                      disabled={busy}
                      title={t('book.removeChapter')}
                    >
                      <X size={13} strokeWidth={1.6} />
                    </button>
                  </span>
                </>
              )}
              {isExpanded && inner.length > 0 && (
                <ul className="chapter-outline">
                  {inner.map((heading, i) => (
                    <li key={`${heading.from}-${i}`}>
                      <button
                        className={`chapter-outline-item level-${Math.min(heading.level, 4)}`}
                        onClick={() => goToLine(chapter, heading.line)}
                        title={heading.text}
                      >
                        {heading.text || t('book.untitledHeading')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {editing === 'new' && <li className="chapter-item">{editorField}</li>}
      </ul>

      {unattachedFiles.length > 0 && (
        <div className="chapter-unattached">
          <div className="chapter-unattached-header">
            <AlertTriangle size={12} strokeWidth={1.5} />
            <span>
              {t('book.unattachedTitle', { count: unattachedFiles.length })}
            </span>
          </div>
          <p className="chapter-unattached-hint">{t('book.unattachedHint')}</p>
          <ul>
            {unattachedFiles.map((file) => (
              <li key={file.filePath}>
                <span className="chapter-unattached-path" title={file.filePath}>
                  {file.suggestedTitle ?? fallbackTitle(file.filePath)}
                </span>
                <button
                  onClick={() => handleAttach(file.filePath)}
                  disabled={busy}
                  title={t('book.attach')}
                >
                  <Link2 size={13} strokeWidth={1.6} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
