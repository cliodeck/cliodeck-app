import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import type { Citation } from '../../stores/bibliography/types';
import { useProjectStore } from '../../stores/projectStore';
import { stillIn } from '../../services/still-in-project';
import './PDFModificationNotification.css';

/** Un PDF modifié tel que `pdf:check-modified-pdfs` le rapporte. */
export interface ModifiedPDF {
  citationId: string;
  zoteroKey?: string;
  attachmentKey: string;
  citationTitle: string;
  filePath: string;
  reason: string; // 'md5-changed' | 'file-modified'
  newMD5?: string;
}

/** Une pièce jointe d'une référence : la clé BibTeX seule peut être commune à plusieurs. */
const modifiedPdfKey = (pdf: ModifiedPDF): string => `${pdf.zoteroKey ?? pdf.citationId}/${pdf.attachmentKey}`;

/** Les vérifications suivant celle du montage. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

type CheckResponse = Awaited<ReturnType<typeof window.electron.pdf.checkModifiedPDFs>>;

/** Une vérification partie dans le main, avec le nombre de réponses de l'historien à son départ. */
interface CheckInFlight {
  projectPath: string;
  answersAtStart: number;
  response: Promise<CheckResponse>;
}

/**
 * La vérification en cours, commune à tous les montages du panneau : quitter l'onglet Bibliographie
 * puis y revenir la rejoint, au lieu de relire tous les PDF une seconde fois pendant qu'elle tourne.
 */
let inFlight: CheckInFlight | null = null;

/**
 * Les réponses de l'historien (réindexés, ou ignorés), tous montages confondus : une vérification
 * partie avant l'une d'elles ne remet rien au bandeau.
 */
let answersGiven = 0;

/** Celle en cours pour ce projet, ou une nouvelle. */
function checkFor(projectPath: string, citations: Citation[]): CheckInFlight {
  if (inFlight?.projectPath === projectPath) return inFlight;
  const check: CheckInFlight = {
    projectPath,
    answersAtStart: answersGiven,
    response: window.electron.pdf.checkModifiedPDFs({ citations, projectPath }),
  };
  inFlight = check;
  const done = () => {
    if (inFlight === check) inFlight = null;
  };
  check.response.then(done, done);
  return check;
}

interface PDFModificationNotificationProps {
  modifiedPDFs: ModifiedPDF[];
  onReindexAll: () => void;
  onReindexSingle: (pdf: ModifiedPDF) => void;
  onDismiss: () => void;
}

export const PDFModificationNotification: React.FC<PDFModificationNotificationProps> = ({
  modifiedPDFs,
  onReindexAll,
  onReindexSingle,
  onDismiss,
}) => {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (modifiedPDFs.length === 0) return null;

  return (
    <div className="pdf-modification-notification">
      <div className="notification-header">
        <div className="notification-icon">
          <AlertCircle size={20} />
        </div>
        <div className="notification-content">
          <div className="notification-title">
            {t('bibliography.modifiedPDFsDetected', { count: modifiedPDFs.length })}
          </div>
          <div className="notification-message">
            {t('bibliography.modifiedPDFsMessage')}
          </div>
        </div>
        <div className="notification-actions">
          <button
            className="notification-btn notification-btn-primary"
            onClick={onReindexAll}
            title={t('bibliography.reindexAll')}
          >
            <RefreshCw size={16} />
            {t('bibliography.reindexAll')}
          </button>
          {modifiedPDFs.length > 1 && (
            <button
              className="notification-btn notification-btn-secondary"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('common.showLess') : t('common.showMore')}
            </button>
          )}
          <button
            className="notification-btn notification-btn-close"
            onClick={onDismiss}
            title={t('common.dismiss')}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Un seul PDF : nommé d'emblée, il n'y a rien à déplier. */}
      {(expanded || modifiedPDFs.length === 1) && (
        <div className="notification-details">
          <ul className="modified-pdfs-list">
            {modifiedPDFs.map((pdf) => (
              <li key={modifiedPdfKey(pdf)} className="modified-pdf-item">
                <div className="modified-pdf-info">
                  <div className="modified-pdf-title">{pdf.citationTitle}</div>
                  <div className="modified-pdf-path">{pdf.filePath}</div>
                </div>
                <button
                  className="notification-btn notification-btn-small"
                  onClick={() => onReindexSingle(pdf)}
                >
                  <RefreshCw size={14} />
                  {t('bibliography.reindex')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

/**
 * Hook to detect modified PDFs and show notification
 *
 * Au montage du panneau, à la fin de l'ouverture d'un projet, puis toutes les cinq minutes ; pas à
 * chaque notice modifiée, qui faisait relire tous les PDF. Une vérification à la fois par projet, y
 * compris d'un montage à l'autre (`inFlight`). La liste vaut pour son projet : vidée quand un autre
 * s'ouvre, et un résultat arrivé pour l'ancien est jeté. Pendant une ouverture, les références
 * affichées sont encore celles du projet sortant : rien n'est vérifié avant sa fin.
 */
export const usePDFModificationDetection = (
  citations: Citation[],
  projectPath: string | undefined
): {
  modifiedPDFs: ModifiedPDF[];
  checkForModifications: () => Promise<void>;
  acknowledge: (answered: ModifiedPDF[]) => Promise<void>;
  dismissNotification: () => void;
} => {
  const [modifiedPDFs, setModifiedPDFs] = useState<ModifiedPDF[]>([]);
  // Lues à chaque vérification, sans en dépendre.
  const citationsRef = useRef(citations);
  citationsRef.current = citations;
  const hasCitations = citations.length > 0;
  const opening = useProjectStore((state) => state.loadState.kind === 'loading');

  const checkForModifications = useCallback(async () => {
    const current = citationsRef.current;
    if (!projectPath || current.length === 0) return;
    try {
      // Celle déjà en cours pour ce projet, s'il y en a une : sa réponse vaut pour ce montage aussi.
      const check = checkFor(projectPath, current);
      const result = await check.response;

      if (!(await stillIn(projectPath)) || answersGiven !== check.answersAtStart) return;
      // Les champs sont à plat (`successResponse`) ; une liste vide vide le bandeau.
      if (result.success) setModifiedPDFs(result.modifiedPDFs ?? []);
      else console.error('Failed to check for modified PDFs:', result.error);
    } catch (error) {
      console.error('Failed to check for modified PDFs:', error);
    }
  }, [projectPath]);

  /**
   * L'historien a répondu pour ces PDF (réindexés, ou ignorés) : ils quittent le bandeau, et le
   * projet retient le MD5 de chacun. Ils ne reviennent que si le fichier change encore. Refusée par
   * le main (un autre projet ouvert, métadonnées illisibles), ou acceptée sans être retenue (une
   * pièce jointe que les métadonnées ne connaissent plus), la réponse ne vaut pas : le PDF reviendra
   * à la vérification suivante.
   */
  const acknowledge = useCallback(
    async (answered: ModifiedPDF[]) => {
      if (answered.length === 0) return;
      answersGiven++;
      const gone = new Set(answered.map(modifiedPdfKey));
      setModifiedPDFs((list) => list.filter((pdf) => !gone.has(modifiedPdfKey(pdf))));

      const pdfs = answered.flatMap((pdf) =>
        pdf.newMD5
          ? [{ citationId: pdf.citationId, zoteroKey: pdf.zoteroKey, attachmentKey: pdf.attachmentKey, md5: pdf.newMD5 }]
          : []
      );
      if (!projectPath || pdfs.length === 0) return;
      try {
        const result = await window.electron.pdf.rememberModifiedPDFs({ projectPath, pdfs });
        if (!result.success) console.warn('⚠️ PDF modifiés : réponse non retenue par le projet', result.error);
        else if ((result.remembered ?? 0) < pdfs.length) {
          console.warn(`⚠️ PDF modifiés : ${pdfs.length - (result.remembered ?? 0)} réponse(s) sur ${pdfs.length} non retenue(s) par le projet`);
        }
      } catch (error) {
        console.error('Failed to remember modified PDFs:', error);
      }
    },
    [projectPath]
  );

  const dismissNotification = useCallback(() => {
    void acknowledge(modifiedPDFs);
  }, [acknowledge, modifiedPDFs]);

  // La liste de A ne s'affiche pas dans B.
  useEffect(() => {
    setModifiedPDFs([]);
  }, [projectPath]);

  // Check on mount and periodically
  useEffect(() => {
    if (opening || !hasCitations) return;
    void checkForModifications();

    const interval = setInterval(() => {
      void checkForModifications();
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [checkForModifications, opening, hasCitations]);

  return {
    modifiedPDFs,
    checkForModifications,
    acknowledge,
    dismissNotification,
  };
};
