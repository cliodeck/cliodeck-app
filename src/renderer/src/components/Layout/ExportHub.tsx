/**
 * ExportHub — center surface for the `export` workspace mode.
 *
 * Regroups the three existing exporters (PDF / Word / Presentation) behind
 * buttons in a dedicated view. We keep the modals themselves untouched and
 * just trigger them from cards, so historians see one clear "Exporter" page
 * instead of discovering three scattered menu items.
 */

import React, { Suspense, lazy, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FileType, Presentation } from 'lucide-react';
import './ExportHub.css';

const PDFExportModal = lazy(() =>
  import('../Export/PDFExportModal').then((m) => ({ default: m.PDFExportModal })),
);
const WordExportModal = lazy(() =>
  import('../Export/WordExportModal').then((m) => ({ default: m.WordExportModal })),
);
const PresentationExportModal = lazy(() =>
  import('../Export/PresentationExportModal').then((m) => ({
    default: m.PresentationExportModal,
  })),
);

type ExportKind = 'pdf' | 'word' | 'presentation' | null;

export const ExportHub: React.FC = () => {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState<ExportKind>(null);

  const cards: {
    id: Exclude<ExportKind, null>;
    icon: React.ReactNode;
    title: string;
    description: string;
  }[] = [
    {
      id: 'pdf',
      icon: <FileText size={24} />,
      title: t('exportHub.pdf.title'),
      description: t('exportHub.pdf.description'),
    },
    {
      id: 'word',
      icon: <FileType size={24} />,
      title: t('exportHub.word.title'),
      description: t('exportHub.word.description'),
    },
    {
      id: 'presentation',
      icon: <Presentation size={24} />,
      title: t('exportHub.presentation.title'),
      description: t('exportHub.presentation.description'),
    },
  ];

  return (
    <div className="export-hub">
      <header className="export-hub__header">
        <h2 className="export-hub__title">{t('exportHub.title')}</h2>
        <p className="export-hub__subtitle">{t('exportHub.subtitle')}</p>
      </header>

      <div className="export-hub__grid">
        {cards.map(({ id, icon, title, description }) => (
          <article key={id} className="export-hub__card">
            <div className="export-hub__card-icon">{icon}</div>
            <h3 className="export-hub__card-title">{title}</h3>
            <p className="export-hub__card-desc">{description}</p>
            <button
              type="button"
              className="export-hub__card-action"
              onClick={() => setOpen(id)}
            >
              {t('exportHub.action')}
            </button>
          </article>
        ))}
      </div>

      {open === 'pdf' && (
        <Suspense fallback={null}>
          <PDFExportModal isOpen onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {open === 'word' && (
        <Suspense fallback={null}>
          <WordExportModal isOpen onClose={() => setOpen(null)} />
        </Suspense>
      )}
      {open === 'presentation' && (
        <Suspense fallback={null}>
          <PresentationExportModal isOpen onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </div>
  );
};
