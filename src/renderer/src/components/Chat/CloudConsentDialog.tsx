/**
 * CloudConsentDialog (ADR 0005, Phase 4.3).
 *
 * Modal shown before the first message of a session when the configured
 * LLM provider is non-localhost. The user must explicitly acknowledge
 * that their research data (RAG chunks, chat content) will be sent to
 * the cloud provider.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CloudOff, Shield } from 'lucide-react';
import './CloudConsentDialog.css';

interface Props {
  providerName: string;
  onConsent: () => void;
  onCancel: () => void;
}

export const CloudConsentDialog: React.FC<Props> = ({
  providerName,
  onConsent,
  onCancel,
}) => {
  const { t } = useTranslation('common');

  return (
    <div className="cloud-consent-overlay" onClick={onCancel}>
      <div className="cloud-consent-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cloud-consent-dialog__icon">
          <CloudOff size={32} />
        </div>
        <h3 className="cloud-consent-dialog__title">
          {t('cloudConsent.title')}
        </h3>
        <p className="cloud-consent-dialog__body">
          {t('cloudConsent.body', { provider: providerName })}
        </p>
        <ul className="cloud-consent-dialog__list">
          <li>{t('cloudConsent.item1')}</li>
          <li>{t('cloudConsent.item2')}</li>
          <li>{t('cloudConsent.item3')}</li>
        </ul>
        <div className="cloud-consent-dialog__hint">
          <Shield size={14} />
          <span>{t('cloudConsent.hint')}</span>
        </div>
        <div className="cloud-consent-dialog__actions">
          <button
            type="button"
            className="cloud-consent-dialog__btn cloud-consent-dialog__btn--cancel"
            onClick={onCancel}
          >
            {t('cloudConsent.cancel')}
          </button>
          <button
            type="button"
            className="cloud-consent-dialog__btn cloud-consent-dialog__btn--accept"
            onClick={onConsent}
          >
            {t('cloudConsent.accept')}
          </button>
        </div>
      </div>
    </div>
  );
};
