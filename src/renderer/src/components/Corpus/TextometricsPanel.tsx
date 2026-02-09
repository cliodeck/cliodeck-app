import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './TextometricsPanel.css';

interface WordFrequency {
  word: string;
  count: number;
  frequency: number;
}

interface Ngram {
  ngram: string;
  count: number;
}

interface TextStatistics {
  totalWords: number;
  uniqueWords: number;
  totalWordsWithStopwords: number;
  vocabularySize: number;
  lexicalRichness: number;
  topWords: WordFrequency[];
  topBigrams: Ngram[];
  topTrigrams: Ngram[];
  totalDocuments?: number;
  averageWordsPerDocument?: number;
  averageVocabularyPerDocument?: number;
  wordFrequencyDistribution?: Record<number, number>;
}

const TOP_N = 20; // Number of top items to display

export const TextometricsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [statistics, setStatistics] = useState<TextStatistics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'words' | 'bigrams' | 'trigrams'>('words');

  const loadTextStatistics = async () => {
    setLoading(true);
    setError(null);

    try {
      console.log('📊 Fetching text statistics...');
      const result = await window.electron.corpus.getTextStatistics({
        topN: TOP_N,
      });

      if (result.success) {
        console.log('✅ Text statistics loaded:', result.statistics);
        setStatistics(result.statistics);
      } else {
        setError(result.error || 'Failed to load text statistics');
      }
    } catch (err: any) {
      console.error('❌ Error loading text statistics:', err);
      setError(err.message || 'An error occurred while loading text statistics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTextStatistics();
  }, []);

  const handleRefresh = () => {
    loadTextStatistics();
  };

  if (loading) {
    return (
      <div className="textometrics-loading">
        <div className="loading-spinner"></div>
        <p>{t('textometrics.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="textometrics-error">
        <p className="error-message">{error}</p>
        <button onClick={handleRefresh} className="btn-refresh">
          {t('textometrics.retry')}
        </button>
      </div>
    );
  }

  if (!statistics) {
    return (
      <div className="textometrics-empty">
        <p>{t('textometrics.noStatistics')}</p>
        <button onClick={loadTextStatistics} className="btn-analyze">
          {t('textometrics.analyze')}
        </button>
      </div>
    );
  }

  const formatNumber = (num: number): string => {
    return num.toLocaleString('fr-FR');
  };

  const formatPercent = (num: number): string => {
    return (num * 100).toFixed(2) + '%';
  };

  return (
    <div className="textometrics-panel">
      {/* Statistiques globales */}
      <div className="textometrics-stats-grid">
        <div className="textometrics-stat-card">
          <div className="stat-label">{t('textometrics.totalWordsNoStopwords')}</div>
          <div className="stat-value">{formatNumber(statistics.totalWords)}</div>
        </div>

        <div className="textometrics-stat-card">
          <div className="stat-label">{t('textometrics.totalWordsWithStopwords')}</div>
          <div className="stat-value">{formatNumber(statistics.totalWordsWithStopwords)}</div>
        </div>

        <div className="textometrics-stat-card">
          <div className="stat-label">{t('textometrics.uniqueVocabulary')}</div>
          <div className="stat-value">{formatNumber(statistics.vocabularySize)}</div>
        </div>

        <div className="textometrics-stat-card">
          <div className="stat-label">{t('textometrics.lexicalRichness')}</div>
          <div className="stat-value">{formatPercent(statistics.lexicalRichness)}</div>
          <div className="stat-description">
            {t('textometrics.lexicalRichnessDesc')}
          </div>
        </div>

        {statistics.totalDocuments && (
          <>
            <div className="textometrics-stat-card">
              <div className="stat-label">{t('textometrics.avgWordsPerDoc')}</div>
              <div className="stat-value">
                {formatNumber(Math.round(statistics.averageWordsPerDocument || 0))}
              </div>
            </div>

            <div className="textometrics-stat-card">
              <div className="stat-label">{t('textometrics.avgVocabPerDoc')}</div>
              <div className="stat-value">
                {formatNumber(Math.round(statistics.averageVocabularyPerDocument || 0))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="textometrics-controls">
        <button onClick={handleRefresh} className="btn-refresh">
          🔄 {t('textometrics.refresh')}
        </button>
      </div>

      {/* Tabs pour les différentes analyses */}
      <div className="textometrics-tabs">
        <button
          className={`tab-button ${activeTab === 'words' ? 'active' : ''}`}
          onClick={() => setActiveTab('words')}
        >
          {t('textometrics.frequentWords')}
        </button>
        <button
          className={`tab-button ${activeTab === 'bigrams' ? 'active' : ''}`}
          onClick={() => setActiveTab('bigrams')}
        >
          {t('textometrics.bigrams')}
        </button>
        <button
          className={`tab-button ${activeTab === 'trigrams' ? 'active' : ''}`}
          onClick={() => setActiveTab('trigrams')}
        >
          {t('textometrics.trigrams')}
        </button>
      </div>

      {/* Content based on active tab */}
      <div className="textometrics-content">
        {activeTab === 'words' && (
          <div className="word-frequency-table">
            <h4>{t('textometrics.topWords', { count: TOP_N })}</h4>
            <table>
              <thead>
                <tr>
                  <th>{t('textometrics.rank')}</th>
                  <th>{t('textometrics.word')}</th>
                  <th>{t('textometrics.occurrences')}</th>
                  <th>{t('textometrics.frequency')}</th>
                  <th>{t('textometrics.bar')}</th>
                </tr>
              </thead>
              <tbody>
                {statistics.topWords.slice(0, TOP_N).map((item, index) => (
                  <tr key={index}>
                    <td className="rank">{index + 1}</td>
                    <td className="word">{item.word}</td>
                    <td className="count">{formatNumber(item.count)}</td>
                    <td className="frequency">{formatPercent(item.frequency)}</td>
                    <td className="bar-cell">
                      <div
                        className="frequency-bar"
                        style={{
                          width: `${(item.frequency / statistics.topWords[0].frequency) * 100}%`,
                        }}
                      ></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'bigrams' && (
          <div className="ngram-frequency-table">
            <h4>{t('textometrics.topBigrams', { count: TOP_N })}</h4>
            <table>
              <thead>
                <tr>
                  <th>{t('textometrics.rank')}</th>
                  <th>{t('textometrics.bigram')}</th>
                  <th>{t('textometrics.occurrences')}</th>
                  <th>{t('textometrics.bar')}</th>
                </tr>
              </thead>
              <tbody>
                {statistics.topBigrams.slice(0, TOP_N).map((item, index) => (
                  <tr key={index}>
                    <td className="rank">{index + 1}</td>
                    <td className="ngram">{item.ngram}</td>
                    <td className="count">{formatNumber(item.count)}</td>
                    <td className="bar-cell">
                      <div
                        className="frequency-bar"
                        style={{
                          width: `${(item.count / statistics.topBigrams[0].count) * 100}%`,
                        }}
                      ></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'trigrams' && (
          <div className="ngram-frequency-table">
            <h4>{t('textometrics.topTrigrams', { count: TOP_N })}</h4>
            <table>
              <thead>
                <tr>
                  <th>{t('textometrics.rank')}</th>
                  <th>{t('textometrics.trigram')}</th>
                  <th>{t('textometrics.occurrences')}</th>
                  <th>{t('textometrics.bar')}</th>
                </tr>
              </thead>
              <tbody>
                {statistics.topTrigrams.slice(0, TOP_N).map((item, index) => (
                  <tr key={index}>
                    <td className="rank">{index + 1}</td>
                    <td className="ngram">{item.ngram}</td>
                    <td className="count">{formatNumber(item.count)}</td>
                    <td className="bar-cell">
                      <div
                        className="frequency-bar"
                        style={{
                          width: `${(item.count / statistics.topTrigrams[0].count) * 100}%`,
                        }}
                      ></div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
