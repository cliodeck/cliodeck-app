import React from 'react';
import { useTranslation } from 'react-i18next';
import './PanelLoadingFallback.css';

export const PanelLoadingFallback: React.FC = () => {
  const { t } = useTranslation('common');

  return (
    <div className="panel-loading-fallback">
      <div className="panel-loading-spinner" />
      <span className="panel-loading-text">{t('common.loading', 'Loading...')}</span>
    </div>
  );
};
