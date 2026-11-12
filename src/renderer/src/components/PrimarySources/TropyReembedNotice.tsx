import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useTropyReembedProposal } from '../../stores/tropyReembedStore';
import { useDialogStore } from '../../stores/dialogStore';

/**
 * La réindexation des sources primaires proposée après un changement de modèle d'embeddings (J7,
 * Q29). Leurs extraits ont été calculés par l'ancien modèle : la recherche par le sens ne peut plus
 * les comparer aux questions, et l'assistant le dit (« Archives : échec »). « Réindexer » les
 * recalcule avec le nouveau, après confirmation, par la passe de la réindexation complète (H7) ;
 * transcriptions gardées, OCR non refait. Fermé, le bandeau revient à la prochaine ouverture du
 * projet, tant que des sources restent à réindexer.
 *
 * Le nombre d'extraits dit est celui d'avant la passe : chaque source est redécoupée, et le compte
 * peut changer.
 */
export const TropyReembedNotice: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const { proposal, reembed, dismiss } = useTropyReembedProposal();
  if (!proposal) return null;

  const n = (value: number) => value.toLocaleString(i18n.language);
  const counts = {
    sources: n(proposal.sources),
    chunks: n(proposal.chunks),
    expected: n(proposal.expected),
    actual: n(proposal.actual),
  };

  const confirmAndReembed = async (): Promise<void> => {
    const dialogs = useDialogStore.getState();
    // Rien ne se perd : pas de bouton rouge (BT1-7). La durée et l'envoi au fournisseur se disent.
    const confirmed = await dialogs.showConfirm(
      t('primarySources.reembed.confirm', counts),
      t('primarySources.reembed.confirmTitle')
    );
    if (!confirmed) return;
    if ((await reembed()) === 'no-embedding-provider') {
      await dialogs.showAlert(t('primarySources.reembed.noProvider'));
    }
  };

  return (
    <div className="tropy-reembed-notice" role="status">
      <AlertTriangle size={16} aria-hidden="true" />
      <div className="tropy-reembed-notice-text">
        <p className="tropy-reembed-notice-title">{t('primarySources.reembed.title')}</p>
        <p>{t('primarySources.reembed.message', counts)}</p>
        <div className="tropy-reembed-notice-actions">
          <button type="button" className="tropy-reembed-notice-button" onClick={() => void confirmAndReembed()}>
            <RefreshCw size={14} aria-hidden="true" />
            {t('primarySources.reembed.action')}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="tropy-reembed-notice-close"
        onClick={dismiss}
        title={t('primarySources.reembed.later')}
        aria-label={t('primarySources.reembed.later')}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
};
