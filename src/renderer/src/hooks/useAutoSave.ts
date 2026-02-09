import { useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';
import { logger } from '../utils/logger';

/**
 * Hook that automatically saves the document after a period of inactivity.
 * Only saves when:
 * - Auto-save is enabled in settings
 * - The document has unsaved changes (isDirty)
 * - A file path exists (not a new unsaved document)
 */
export function useAutoSave(): void {
  const { isDirty, filePath, settings, saveFile } = useEditorStore();
  const { autoSave, autoSaveDelay } = settings;

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);

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
    } finally {
      isSavingRef.current = false;
    }
  }, [saveFile]);

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
    timeoutRef.current = setTimeout(() => {
      performAutoSave();
    }, autoSaveDelay);

    // Cleanup on unmount or when dependencies change
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [autoSave, autoSaveDelay, isDirty, filePath, performAutoSave]);
}
