/**
 * Panneau des brouillons Brainstorm (#7, A13 option c).
 *
 * Panneau flottant du mode Écriture (même famille que SimilarityPanel) :
 * liste des réponses mises de côté depuis le chat, chacune proposable au
 * curseur par son bouton, ou au point de dépôt en glissant sa carte dans
 * l'éditeur (D9 : l'éditeur reconnaît la carte et la propose, jamais par le
 * dépôt natif de CM6), ou jetable. Dans les deux cas la proposition reste
 * adjudicable (`proposeQueuedDraft`), et elle ne fait pas sortir le
 * brouillon de la file : seule son acceptation le fait.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownToLine, Check, GripVertical, Inbox, Trash2, X } from 'lucide-react';
import { useDraftsStore, draftTitle, draftsForProject, type BrainstormDraft } from '../../stores/draftsStore';
import { useProjectStore } from '../../stores/projectStore';
import { useDialogStore } from '../../stores/dialogStore';
import { DRAFT_DRAG_TYPE, proposeQueuedDraft } from './draft-proposal';
import './DraftsPanel.css';

const DraftCard: React.FC<{ draft: BrainstormDraft }> = ({ draft }) => {
  const { t } = useTranslation('common');
  const remove = useDraftsStore((s) => s.remove);
  const inserted = useDraftsStore((s) => s.proposedIds.includes(draft.id));

  return (
    <div
      className="drafts-panel__card"
      // Déjà proposée, elle ne se glisse pas, comme son bouton est désactivé.
      draggable={!inserted}
      onDragStart={(e) => {
        if (inserted) {
          e.preventDefault();
          return;
        }
        // Le dépôt dans l'éditeur ne fait qu'une proposition, et la carte attend sa décision : elle
        // ne quitte pas la file au `dragend`. `text/plain` sert un dépôt hors de ClioDeck, une copie
        // qui ne vaut pas acceptation.
        e.dataTransfer.setData(DRAFT_DRAG_TYPE, draft.id);
        e.dataTransfer.setData('text/plain', draft.content);
        e.dataTransfer.effectAllowed = 'copy';
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
          onClick={() => proposeQueuedDraft(draft.id, 'cursor', t)}
          disabled={inserted}
          title={t('drafts.insertTitle')}
        >
          {inserted ? <Check size={12} /> : <ArrowDownToLine size={12} />}{' '}
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
  // Ceux du projet ouvert, et ceux d'avant la règle, sans projet (Q12) : une réponse faite des
  // sources de A n'a pas à être proposée dans le manuscrit de B.
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);
  const queue = useDraftsStore((s) => s.drafts);
  const drafts = useMemo(() => draftsForProject(queue, projectPath), [queue, projectPath]);
  const closePanel = useDraftsStore((s) => s.closePanel);
  const clear = useDraftsStore((s) => s.clear);

  const handleClear = async () => {
    if (drafts.length === 0) return;
    if (
      await useDialogStore
        .getState()
        .showConfirm(t('drafts.clearConfirm', { count: drafts.length }), undefined, { danger: true })
    ) {
      clear(projectPath);
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
