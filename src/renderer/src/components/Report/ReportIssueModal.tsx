import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ExternalLink } from 'lucide-react';
import './ReportIssueModal.css';

interface ReportIssueModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type IssueType = 'bug' | 'feature' | 'question';

const GITHUB_REPO = 'cliodeck/cliodeck-app';

const LABEL_MAP: Record<IssueType, string> = {
  bug: 'bug',
  feature: 'enhancement',
  question: 'question',
};

export const ReportIssueModal: React.FC<ReportIssueModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('common');
  const [issueType, setIssueType] = useState<IssueType>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (!isOpen) return null;

  const getSystemInfo = (): string => {
    const ua = navigator.userAgent;
    const lines = [
      `- **User Agent**: ${ua}`,
    ];
    return lines.join('\n');
  };

  const handleSubmit = () => {
    if (!title.trim()) return;

    const bodyParts = [];

    if (description.trim()) {
      bodyParts.push('## Description\n' + description.trim());
    }

    bodyParts.push('## ' + t('report.systemInfo') + '\n' + getSystemInfo());

    const body = bodyParts.join('\n\n');
    const label = LABEL_MAP[issueType];

    const params = new URLSearchParams({
      title: title.trim(),
      body,
      labels: label,
    });

    const url = `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
    window.electron.shell.openExternal(url);

    setSubmitted(true);
  };

  const handleClose = () => {
    setTitle('');
    setDescription('');
    setIssueType('bug');
    setSubmitted(false);
    onClose();
  };

  return (
    <div className="report-issue-modal" onClick={handleClose}>
      <div className="report-issue-content" onClick={(e) => e.stopPropagation()}>
        <div className="report-issue-header">
          <h3>{t('report.title')}</h3>
          <button className="close-btn" onClick={handleClose}>
            <X size={20} />
          </button>
        </div>

        <div className="report-issue-body">
          {submitted ? (
            <div className="report-success">
              <ExternalLink size={16} />
              {t('report.submitted')}
            </div>
          ) : (
            <>
              <div className="form-field">
                <label>{t('report.type')}</label>
                <select
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value as IssueType)}
                >
                  <option value="bug">{t('report.typeBug')}</option>
                  <option value="feature">{t('report.typeFeature')}</option>
                  <option value="question">{t('report.typeQuestion')}</option>
                </select>
              </div>

              <div className="form-field">
                <label>{t('report.issueTitle')}</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('report.issueTitlePlaceholder')}
                  autoFocus
                />
              </div>

              <div className="form-field">
                <label>{t('report.description')}</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('report.descriptionPlaceholder')}
                  rows={6}
                />
              </div>
            </>
          )}
        </div>

        <div className="report-issue-footer">
          <button className="btn-cancel" onClick={handleClose}>
            {t('actions.cancel')}
          </button>
          {!submitted && (
            <button
              className="btn-export"
              onClick={handleSubmit}
              disabled={!title.trim()}
            >
              <ExternalLink size={16} />
              {t('report.submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
