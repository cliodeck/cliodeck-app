import React from 'react';
import { useTranslation } from 'react-i18next';
import { ZoteroAttachmentInfo } from '../../stores/bibliographyStore';
import './PDFSelectionDialog.css';

interface PDFSelectionDialogProps {
  citationTitle: string;
  attachments: ZoteroAttachmentInfo[];
  onSelect: (attachmentKey: string) => void;
  onCancel: () => void;
}

export const PDFSelectionDialog: React.FC<PDFSelectionDialogProps> = ({
  citationTitle,
  attachments,
  onSelect,
  onCancel,
}) => {
  const { t } = useTranslation('common');

  return (
    <div className="pdf-selection-overlay" onClick={onCancel}>
      <div className="pdf-selection-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="pdf-selection-header">
          <h3>{t('bibliography.selectPDF')}</h3>
          <button className="close-btn" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="pdf-selection-citation">
          <strong>{citationTitle}</strong>
        </div>

        <div className="pdf-selection-list">
          {attachments.map((attachment) => (
            <button
              key={attachment.key}
              className="pdf-selection-item"
              onClick={() => onSelect(attachment.key)}
            >
              <div className="pdf-item-icon">📄</div>
              <div className="pdf-item-info">
                <div className="pdf-item-filename">{attachment.filename}</div>
                {attachment.dateModified && (
                  <div className="pdf-item-date">
                    {t('bibliography.modified')}: {new Date(attachment.dateModified).toLocaleDateString()}
                  </div>
                )}
              </div>
              <div className="pdf-item-action">→</div>
            </button>
          ))}
        </div>

        <div className="pdf-selection-footer">
          <button className="btn-cancel" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};
