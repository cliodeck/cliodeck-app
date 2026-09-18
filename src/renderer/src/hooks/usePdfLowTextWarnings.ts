import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '../stores/notificationStore';

/**
 * Avertit quand un PDF indexé n'a presque pas de texte (#132).
 *
 * Un scan non OCRisé ou un « Imprimer en PDF » d'images s'indexe sans erreur,
 * mais la recherche n'y trouvera rien : sans ce message, l'historien le croit
 * consultable. Le processus principal émet `pdf:low-text` quel que soit le
 * bouton qui a lancé l'indexation ; on l'écoute ici, une seule fois.
 */
export function usePdfLowTextWarnings(): void {
  const { t } = useTranslation('common');
  const notify = useNotificationStore((s) => s.notify);

  useEffect(() => {
    const onLowText = window.electron?.pdf?.onLowText;
    if (!onLowText) return;
    const unsubscribe = onLowText((info) => {
      notify({
        level: 'warning',
        title: t('pdfLowText.title'),
        message: t('pdfLowText.message', { title: info.title || info.fileName }),
        details: t('pdfLowText.details', {
          fileName: info.fileName,
          pageCount: info.pageCount,
          charsPerPage: info.charsPerPage,
        }),
        duration: 12000,
      });
    });
    return () => {
      unsubscribe();
    };
  }, [notify, t]);
}
