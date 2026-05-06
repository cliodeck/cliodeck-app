import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanSearch, FileText, BarChart3 } from 'lucide-react';
import './OCRSourceReport.css';

interface SourceOCRReport {
  sourceId: string;
  title: string;
  ocrConfidence: number | null;
  transcriptionSource: string | null;
  chunkCount: number;
  avgQualityScore: number | null;
  minQualityScore: number | null;
  maxQualityScore: number | null;
  transcriptionLength: number;
}

interface OCRSourceReportProps {
  sourceId: string;
}

function confidenceColor(value: number): string {
  if (value >= 70) return 'var(--color-success, #22c55e)';
  if (value >= 40) return 'color-mix(in srgb, var(--color-danger) 50%, transparent)';
  return 'var(--color-danger)';
}

function qualityLabel(score: number): string {
  if (score >= 0.7) return 'good';
  if (score >= 0.4) return 'medium';
  return 'low';
}

export const OCRSourceReport: React.FC<OCRSourceReportProps> = ({ sourceId }) => {
  const { t } = useTranslation('common');
  const [report, setReport] = useState<SourceOCRReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    window.electron.tropy.getSourceOCRReport(sourceId).then((result: { success: boolean; report?: SourceOCRReport }) => {
      if (!cancelled) {
        setReport(result.success ? (result.report ?? null) : null);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [sourceId]);

  if (loading) {
    return <div className="ocr-source-report loading">...</div>;
  }

  if (!report) {
    return null;
  }

  const hasOCR = report.ocrConfidence !== null;
  const hasQuality = report.avgQualityScore !== null;

  if (!hasOCR && !hasQuality && report.chunkCount === 0) {
    return (
      <div className="ocr-source-report empty">
        <span className="ocr-report-empty-text">
          {t('primarySources.noOCRData')}
        </span>
      </div>
    );
  }

  return (
    <div className="ocr-source-report">
      <div className="ocr-report-header">
        <ScanSearch size={14} strokeWidth={1.5} />
        <span>{t('primarySources.ocrReport')}</span>
      </div>

      <div className="ocr-report-grid">
        {/* OCR Confidence */}
        {hasOCR && (
          <div className="ocr-report-metric">
            <div
              className="ocr-report-value"
              style={{ color: confidenceColor(report.ocrConfidence!) }}
            >
              {Math.round(report.ocrConfidence!)}%
            </div>
            <div className="ocr-report-label">{t('primarySources.ocrConfidence')}</div>
          </div>
        )}

        {/* Chunk count */}
        <div className="ocr-report-metric">
          <div className="ocr-report-value">
            <FileText size={12} strokeWidth={1.5} />
            {report.chunkCount}
          </div>
          <div className="ocr-report-label">{t('primarySources.chunks')}</div>
        </div>

        {/* Avg quality */}
        {hasQuality && (
          <div className="ocr-report-metric">
            <div className={`ocr-report-value quality-${qualityLabel(report.avgQualityScore!)}`}>
              <BarChart3 size={12} strokeWidth={1.5} />
              {(report.avgQualityScore! * 100).toFixed(0)}%
            </div>
            <div className="ocr-report-label">{t('primarySources.avgQuality')}</div>
          </div>
        )}

        {/* Transcription length */}
        {report.transcriptionLength > 0 && (
          <div className="ocr-report-metric">
            <div className="ocr-report-value">
              {report.transcriptionLength.toLocaleString()}
            </div>
            <div className="ocr-report-label">{t('primarySources.characters')}</div>
          </div>
        )}
      </div>

      {/* Transcription source */}
      {report.transcriptionSource && (
        <div className="ocr-report-source">
          <span className="ocr-report-source-label">{t('primarySources.transcriptionSource')}:</span>
          <span className="ocr-report-source-value">
            {t(`primarySources.${report.transcriptionSource}`, report.transcriptionSource)}
          </span>
        </div>
      )}
    </div>
  );
};
