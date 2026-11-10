import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { useTropyReindexStatus } from '../../stores/tropyReindexStore';
import { describeReindexStatus } from './reindex-status';

/**
 * La réindexation complète des sources primaires (H7), dite dans le panneau
 * pendant toute sa durée : imposée à l'historien, elle peut prendre des heures.
 */
export const TropyReindexNotice: React.FC = () => {
  const { t, i18n } = useTranslation('common');
  const status = useTropyReindexStatus();
  const text = describeReindexStatus(t, status, i18n.language);
  if (!text) return null;

  const Icon = status.phase === 'stopped' ? AlertTriangle : status.phase === 'done' ? CheckCircle : RefreshCw;
  const spinning = status.phase === 'running' && !status.waitingForSync;
  return (
    <div className={`sync-notice reindex-notice reindex-notice--${status.phase}`} role="status">
      <Icon size={14} strokeWidth={1.5} className={spinning ? 'spinning' : undefined} />
      <span>{text}</span>
    </div>
  );
};
