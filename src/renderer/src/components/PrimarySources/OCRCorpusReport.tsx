import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch, X, AlertTriangle, CheckCircle } from 'lucide-react';
import './OCRCorpusReport.css';

interface CorpusOCRReport {
  totalSources: number;
  sourcesWithOCR: number;
  sourcesWithTranscription: number;
  avgOCRConfidence: number | null;
  confidenceDistribution: { bucket: string; count: number }[];
  avgChunkQuality: number | null;
  totalChunks: number;
  chunksWithQuality: number;
  worstSources: Array<{ id: string; title: string; ocrConfidence: number }>;
  bestSources: Array<{ id: string; title: string; ocrConfidence: number }>;
  byTranscriptionSource: Record<string, number>;
}

interface OCRCorpusReportProps {
  onClose: () => void;
}

function confidenceColor(value: number): string {
  if (value >= 70) return 'var(--color-success, #22c55e)';
  if (value >= 40) return 'color-mix(in srgb, var(--color-danger) 50%, transparent)';
  return 'var(--color-danger)';
}

export const OCRCorpusReport: React.FC<OCRCorpusReportProps> = ({ onClose }) => {
  const { t } = useTranslation('common');
  const [report, setReport] = useState<CorpusOCRReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.electron.tropy.getCorpusOCRReport().then((result: { success: boolean; report?: CorpusOCRReport }) => {
      setReport(result.success ? (result.report ?? null) : null);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="ocr-corpus-report">
        <div className="ocr-corpus-header">
          <span>...</span>
        </div>
      </div>
    );
  }

  if (!report || (report.sourcesWithOCR === 0 && report.totalChunks === 0)) {
    return (
      <div className="ocr-corpus-report">
        <div className="ocr-corpus-header">
          <span className="ocr-corpus-title">
            <ScanSearch size={16} strokeWidth={1.5} />
            {t('primarySources.corpusOCRTitle')}
          </span>
          <button className="ocr-corpus-close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <p className="ocr-corpus-empty">{t('primarySources.noCorpusData')}</p>
      </div>
    );
  }

  const maxBucketCount = Math.max(...report.confidenceDistribution.map(b => b.count), 1);

  return (
    <div className="ocr-corpus-report">
      <div className="ocr-corpus-header">
        <span className="ocr-corpus-title">
          <ScanSearch size={16} strokeWidth={1.5} />
          {t('primarySources.corpusOCRTitle')}
        </span>
        <button className="ocr-corpus-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {/* Summary stats */}
      <div className="ocr-corpus-summary">
        <div className="ocr-corpus-stat">
          <span className="ocr-corpus-stat-num">{report.sourcesWithTranscription}</span>
          <span className="ocr-corpus-stat-label">
            / {report.totalSources} {t('primarySources.sourcesTranscribed')}
          </span>
        </div>
        {report.avgOCRConfidence !== null && (
          <div className="ocr-corpus-stat">
            <span
              className="ocr-corpus-stat-num"
              style={{ color: confidenceColor(report.avgOCRConfidence) }}
            >
              {Math.round(report.avgOCRConfidence)}%
            </span>
            <span className="ocr-corpus-stat-label">{t('primarySources.avgCorpusConfidence')}</span>
          </div>
        )}
        {report.avgChunkQuality !== null && (
          <div className="ocr-corpus-stat">
            <span className="ocr-corpus-stat-num">
              {(report.avgChunkQuality * 100).toFixed(0)}%
            </span>
            <span className="ocr-corpus-stat-label">
              {t('primarySources.chunkQuality')} ({report.totalChunks} {t('primarySources.chunks')})
            </span>
          </div>
        )}
      </div>

      {/* Confidence distribution */}
      {report.sourcesWithOCR > 0 && (
        <div className="ocr-corpus-section">
          <h5>{t('primarySources.confidenceDistribution')}</h5>
          <div className="ocr-corpus-histogram">
            {report.confidenceDistribution.map((bucket) => (
              <div key={bucket.bucket} className="ocr-histogram-bar-wrapper">
                <div
                  className="ocr-histogram-bar"
                  style={{
                    height: `${(bucket.count / maxBucketCount) * 100}%`,
                  }}
                />
                <span className="ocr-histogram-label">{bucket.bucket}</span>
                {bucket.count > 0 && (
                  <span className="ocr-histogram-count">{bucket.count}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By transcription source */}
      {Object.keys(report.byTranscriptionSource).length > 0 && (
        <div className="ocr-corpus-section">
          <h5>{t('primarySources.byTranscriptionSource')}</h5>
          <ul className="ocr-corpus-list">
            {Object.entries(report.byTranscriptionSource).map(([source, count]) => (
              <li key={source}>
                <span>{t(`primarySources.${source}`, source)}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Worst sources */}
      {report.worstSources.length > 0 && (
        <div className="ocr-corpus-section">
          <h5>
            <AlertTriangle size={12} strokeWidth={1.5} />
            {t('primarySources.worstSources')}
          </h5>
          <ul className="ocr-corpus-list">
            {report.worstSources.map((s) => (
              <li key={s.id}>
                <span className="ocr-corpus-source-title">{s.title}</span>
                <strong style={{ color: confidenceColor(s.ocrConfidence) }}>
                  {Math.round(s.ocrConfidence)}%
                </strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Best sources */}
      {report.bestSources.length > 0 && (
        <div className="ocr-corpus-section">
          <h5>
            <CheckCircle size={12} strokeWidth={1.5} />
            {t('primarySources.bestSources')}
          </h5>
          <ul className="ocr-corpus-list">
            {report.bestSources.map((s) => (
              <li key={s.id}>
                <span className="ocr-corpus-source-title">{s.title}</span>
                <strong style={{ color: confidenceColor(s.ocrConfidence) }}>
                  {Math.round(s.ocrConfidence)}%
                </strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
