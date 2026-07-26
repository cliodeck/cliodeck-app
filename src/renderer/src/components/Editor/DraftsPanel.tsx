/**
 * Panneau des brouillons Brainstorm (#7, A13 option c).
 *
 * Panneau flottant du mode Écriture (même famille que SimilarityPanel) :
 * liste des réponses mises de côté depuis le chat, chacune insérable au
 * curseur (via `insertDraftAtCursor` — la proposition reste adjudicable
 * et annulable), glissable dans l'éditeur (drop natif CM6 : le texte
 * s'insère à la position exacte du dépôt, Cmd+Z l'annule), ou jetable.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, GripVertical, Inbox, Trash2, X } from 'lucide-react';
import { useDraftsStore, draftTitle, type BrainstormDraft } from '../../stores/draftsStore';
import { useEditorStore } from '../../stores/editorStore';
import { useDialogStore } from '../../stores/dialogStore';
import './DraftsPanel.css';

const DraftCard: React.FC<{ draft: BrainstormDraft }> = ({ draft }) => {
  const { t } = useTranslation('common');
  const remove = useDraftsStore((s) => s.remove);
  const [inserted, setInserted] = useState(false);

  const insertAtCursor = () => {
    const { mode } = useEditorStore
      .getState()
      .insertDraftAtCursor(draft.content, draft.source);
    setInserted(true);
    // Laisse le feedback visible un instant avant de sortir de la file.
    setTimeout(() => remove(draft.id), 600);
    void mode;
  };

  return (
    <div
      className="drafts-panel__card"
      draggable
      onDragStart={(e) => {
        // Drop natif CM6 : le texte s'insère à la position du dépôt, avec
        // l'historique d'annulation de l'éditeur (userEvent input.drop).
        e.dataTransfer.setData('text/plain', draft.content);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDragEnd={(e) => {
        // dropEffect 'none' = glissé annulé (Échap, dépôt hors cible).
        if (e.dataTransfer.dropEffect !== 'none') remove(draft.id);
      }}
    >
      <div className="drafts-panel__card-head">
        <GripVertical size={13} className="drafts-panel__grip" aria-hidden />
        <strong className="drafts-panel__card-title">{draftTitle(draft)}</strong>
        <span className="drafts-panel__card-date">
          {new Date(draft.createdAt).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
      <p className="drafts-panel__card-snippet">{draft.content.slice(0, 220)}</p>
      <div className="drafts-panel__card-actions">
        <button
          type="button"
          className="chat-surface__inline-btn"
          onClick={insertAtCursor}
          disabled={inserted}
          title={t('drafts.insertTitle')}
        >
          <ArrowDownToLine size={12} />{' '}
          {inserted ? t('drafts.inserted') : t('drafts.insert')}
        </button>
        <button
          type="button"
          className="chat-surface__inline-btn drafts-panel__discard"
          onClick={() => remove(draft.id)}
          title={t('drafts.discardTitle')}
        >
          <Trash2 size={12} /> {t('drafts.discard')}
        </button>
      </div>
    </div>
  );
};

export const DraftsPanel: React.FC = () => {
  const { t } = useTranslation('common');
  const drafts = useDraftsStore((s) => s.drafts);
  const closePanel = useDraftsStore((s) => s.closePanel);
  const clear = useDraftsStore((s) => s.clear);

  const handleClear = async () => {
    if (drafts.length === 0) return;
    if (
      await useDialogStore
        .getState()
        .showConfirm(t('drafts.clearConfirm', { count: drafts.length }))
    ) {
      clear();
    }
  };

  return (
    <div className="drafts-panel" role="complementary" aria-label={t('drafts.title')}>
      <div className="drafts-panel__header">
        <span className="drafts-panel__title">
          <Inbox size={14} /> {t('drafts.title')} ({drafts.length})
        </span>
        <div className="drafts-panel__header-actions">
          <button
            type="button"
            className="drafts-panel__icon-btn"
            onClick={() => void handleClear()}
            disabled={drafts.length === 0}
            title={t('drafts.clearAll')}
            aria-label={t('drafts.clearAll')}
          >
            <Trash2 size={13} />
          </button>
          <button
            type="button"
            className="drafts-panel__icon-btn"
            onClick={closePanel}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {drafts.length === 0 ? (
        <p className="drafts-panel__empty">{t('drafts.empty')}</p>
      ) : (
        <>
          <p className="drafts-panel__hint">{t('drafts.dragHint')}</p>
          <div className="drafts-panel__list">
            {drafts.map((d) => (
              <DraftCard key={d.id} draft={d} />
            ))}
          </div>
        </>
      )}
    </div>
  );
};
