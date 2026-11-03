import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { useNotificationStore } from '../stores/notificationStore';
import i18n from '../i18n';
import { logger } from '../utils/logger';

/** Un disque plein ne se libère pas en 3 s : les essais s'éloignent, jusqu'à ce plafond. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Hook that automatically saves the document after a period of inactivity.
 * Only saves when:
 * - Auto-save is enabled in settings
 * - The document has unsaved changes (isDirty)
 * - A file path exists (not a new unsaved document)
 *
 * Tant qu'il reste du texte à écrire, un nouvel essai est prévu : `isDirty` resté vrai
 * ne repasse jamais de faux à vrai, ni après une frappe pendant l'écriture, ni après un
 * échec. Sur un échec, l'auteur est prévenu une fois par série, et les essais s'éloignent.
 */
export function useAutoSave(): void {
  const { isDirty, filePath, documentVersion, lastSavedAt, settings, saveFile } = useEditorStore();
  const { autoSave, autoSaveDelay } = settings;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  const mountedRef = useRef(true);
  /** Échecs d'affilée sur ce document, et le message qui les annonce. */
  const failuresRef = useRef(0);
  const failureNoticeRef = useRef<string | null>(null);
  /** Chaque essai terminé relance l'effet du minuteur : aucune autre dépendance ne bouge. */
  const [finishedAttempts, setFinishedAttempts] = useState(0);

  const performAutoSave = useCallback(async () => {
    if (isSavingRef.current) {
      return;
    }

    const currentState = useEditorStore.getState();

    // Double-check conditions before saving
    if (!currentState.isDirty || !currentState.filePath || !currentState.settings.autoSave) {
      return;
    }

    isSavingRef.current = true;
    logger.store('AutoSave', 'Auto-saving document', { filePath: currentState.filePath });

    try {
      await saveFile();
      logger.store('AutoSave', 'Document auto-saved successfully');
    } catch (error) {
      logger.error('AutoSave', error);
      // Le document a changé pendant l'écriture : cet échec ne dit rien du nouveau.
      const sameDocument = useEditorStore.getState().documentVersion === currentState.documentVersion;
      if (sameDocument && mountedRef.current) {
        failuresRef.current += 1;
        if (failuresRef.current === 1) {
          failureNoticeRef.current = useNotificationStore.getState().notify({
            level: 'error',
            title: i18n.t('editor.autoSaveFailed'),
            message: i18n.t('editor.autoSaveFailedHint'),
            details: error instanceof Error ? error.message : String(error),
            duration: 0,
          });
        }
      }
    } finally {
      isSavingRef.current = false;
      setFinishedAttempts((n) => n + 1);
    }
  }, [saveFile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Une écriture réussie, un autre document, ou plus de panneau d'écriture : la série est finie.
  useEffect(
    () => () => {
      failuresRef.current = 0;
      if (failureNoticeRef.current) useNotificationStore.getState().dismiss(failureNoticeRef.current);
      failureNoticeRef.current = null;
    },
    [documentVersion, lastSavedAt]
  );

  useEffect(() => {
    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Only set up auto-save if enabled and conditions are met
    if (!autoSave || !isDirty || !filePath) {
      return;
    }

    // Schedule auto-save after delay
    const ceiling = Math.max(autoSaveDelay, MAX_RETRY_DELAY_MS);
    const delay = Math.min(autoSaveDelay * 2 ** failuresRef.current, ceiling);
    timeoutRef.current = setTimeout(() => {
      performAutoSave();
    }, delay);

    // Cleanup on unmount or when dependencies change
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [autoSave, autoSaveDelay, isDirty, filePath, lastSavedAt, finishedAttempts, performAutoSave]);
}
