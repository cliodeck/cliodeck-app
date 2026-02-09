import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search, Book, AlertCircle } from 'lucide-react';
import methodologyGuide from '../../../../../backend/data/methodology-guide.json';
import './MethodologyModal.css';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialFeature?: string; // Pour ouvrir directement sur une feature
}

type ViewMode = 'overview' | 'feature' | 'faq' | 'glossary';

export const MethodologyModal: React.FC<Props> = ({ isOpen, onClose, initialFeature }) => {
  const { t } = useTranslation('common');
  const [viewMode, setViewMode] = useState<ViewMode>('overview');
  const [selectedFeature, setSelectedFeature] = useState<string | null>(initialFeature || null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (initialFeature && isOpen) {
      setViewMode('feature');
      setSelectedFeature(initialFeature);
    }
  }, [initialFeature, isOpen]);

  if (!isOpen) return null;

  const features = methodologyGuide.features;
  const faq = methodologyGuide.faq;
  const glossary = methodologyGuide.glossary;

  // Filter FAQ based on search
  const filteredFaq = faq.filter(
    (item) =>
      item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.answer.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Filter glossary based on search
  const filteredGlossary = Object.entries(glossary).filter(
    ([term, definition]) =>
      term.toLowerCase().includes(searchQuery.toLowerCase()) ||
      definition.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderFeatureDetail = (featureKey: string) => {
    const feature = features[featureKey];
    if (!feature) return null;

    return (
      <div className="feature-detail">
        <h2>{feature.title}</h2>
        <p className="feature-description">{feature.description}</p>

        <section className="detail-section">
          <h3>✓ {t('methodology.capabilities')}</h3>
          <ul>
            {feature.capabilities.map((cap, idx) => (
              <li key={idx}>{cap}</li>
            ))}
          </ul>
        </section>

        <section className="detail-section">
          <h3>⚠ {t('methodology.limitations')}</h3>
          <ul className="limitations-list">
            {feature.limitations.map((lim, idx) => (
              <li key={idx}>{lim}</li>
            ))}
          </ul>
        </section>

        <section className="detail-section">
          <h3>💡 {t('methodology.bestPractices')}</h3>
          <ul>
            {feature.bestPractices.map((practice, idx) => (
              <li key={idx}>{practice}</li>
            ))}
          </ul>
        </section>

        <section className="detail-section academic-context">
          <h3>📚 {t('methodology.academicContext')}</h3>
          <p>{feature.academicContext}</p>
        </section>
      </div>
    );
  };

  return (
    <div className="methodology-modal-overlay" onClick={onClose}>
      <div className="methodology-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div className="modal-title">
            <Book size={24} />
            <h2>{t('methodology.title')}</h2>
          </div>
          <button className="close-btn" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Navigation */}
        <div className="modal-nav">
          <button
            className={viewMode === 'overview' ? 'active' : ''}
            onClick={() => setViewMode('overview')}
          >
            {t('methodology.overview')}
          </button>
          <button
            className={viewMode === 'feature' ? 'active' : ''}
            onClick={() => {
              setViewMode('feature');
              if (!selectedFeature) setSelectedFeature('chat');
            }}
          >
            {t('methodology.features')}
          </button>
          <button className={viewMode === 'faq' ? 'active' : ''} onClick={() => setViewMode('faq')}>
            {t('methodology.faq')}
          </button>
          <button
            className={viewMode === 'glossary' ? 'active' : ''}
            onClick={() => setViewMode('glossary')}
          >
            {t('methodology.glossary')}
          </button>
        </div>

        {/* Search bar (for FAQ and Glossary) */}
        {(viewMode === 'faq' || viewMode === 'glossary') && (
          <div className="search-bar">
            <Search size={16} />
            <input
              type="text"
              placeholder={t('methodology.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        )}

        {/* Content */}
        <div className="modal-content">
          {viewMode === 'overview' && (
            <div className="overview">
              <h2>{t('methodology.welcome')}</h2>
              <p className="intro">
                {t('methodology.intro')}
              </p>

              <div className="alert-box">
                <AlertCircle size={20} />
                <div>
                  <strong>{t('methodology.importantWarning')}</strong> {t('methodology.importantWarningText')}
                </div>
              </div>

              <h3>{t('methodology.mainFeatures')}</h3>
              <div className="feature-cards">
                {Object.entries(features).map(([key, feature]) => (
                  <div
                    key={key}
                    className="feature-card"
                    onClick={() => {
                      setSelectedFeature(key);
                      setViewMode('feature');
                    }}
                  >
                    <h4>{feature.title}</h4>
                    <p>{feature.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {viewMode === 'feature' && (
            <div className="feature-view">
              <div className="feature-sidebar">
                <h3>{t('methodology.features')}</h3>
                {Object.entries(features).map(([key, feature]) => (
                  <button
                    key={key}
                    className={selectedFeature === key ? 'active' : ''}
                    onClick={() => setSelectedFeature(key)}
                  >
                    {feature.title}
                  </button>
                ))}
              </div>
              <div className="feature-content">
                {selectedFeature && renderFeatureDetail(selectedFeature)}
              </div>
            </div>
          )}

          {viewMode === 'faq' && (
            <div className="faq-view">
              <h2>{t('methodology.faqTitle')}</h2>
              {filteredFaq.length === 0 ? (
                <p className="no-results">{t('methodology.noResults')} "{searchQuery}"</p>
              ) : (
                filteredFaq.map((item, idx) => (
                  <div key={idx} className="faq-item">
                    <h4>{item.question}</h4>
                    <p>{item.answer}</p>
                    <span className="faq-category">{item.category}</span>
                  </div>
                ))
              )}
            </div>
          )}

          {viewMode === 'glossary' && (
            <div className="glossary-view">
              <h2>{t('methodology.glossaryTitle')}</h2>
              {filteredGlossary.length === 0 ? (
                <p className="no-results">{t('methodology.noResults')} "{searchQuery}"</p>
              ) : (
                filteredGlossary.map(([term, definition]) => (
                  <div key={term} className="glossary-item">
                    <dt>{term}</dt>
                    <dd>{definition}</dd>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
