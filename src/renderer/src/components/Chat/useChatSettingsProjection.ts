/**
 * useChatSettingsProjection
 *
 * Shared hook that projects the renderer's `ragQueryStore.params` +
 * `modeStore.activeMode` onto `chatStore.chatSettings`, so every
 * `fusion:chat:start` (triggered from either Write or Brainstorm)
 * picks up the current filters / mode / custom prompt.
 *
 * Extracted from ChatInterface so Brainstorm can reuse the exact same
 * wiring without duplicating the effect.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useChatStore,
  type BrainstormChatRetrievalSettings,
} from '../../stores/chatStore';
import { useModeStore } from '../../stores/modeStore';
import { useRAGQueryStore, getResolvedSourceType } from '../../stores/ragQueryStore';

export function useChatSettingsProjection(): void {
  const { i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const setChatSettings = useChatStore((s) => s.setChatSettings);
  const { activeMode, activeModeId } = useModeStore();
  const ragParams = useRAGQueryStore((s) => s.params);

  useEffect(() => {
    // Resolve the three independent source toggles into the (sourceType,
    // includeVault) pair understood by the retrieval pipeline. When all
    // three toggles are off we still project a permissive fallback so
    // retrieval never silently breaks — the UI surfaces the warning.
    const resolved = getResolvedSourceType(ragParams);
    const retrieval: BrainstormChatRetrievalSettings = {
      topK: ragParams.topK,
      documentIds:
        ragParams.selectedDocumentIds && ragParams.selectedDocumentIds.length > 0
          ? ragParams.selectedDocumentIds
          : undefined,
      collectionKeys:
        ragParams.selectedCollectionKeys && ragParams.selectedCollectionKeys.length > 0
          ? ragParams.selectedCollectionKeys
          : undefined,
      sourceType: resolved.sourceType,
      includeVault: resolved.includeVault,
    };
    let customSystemPrompt: string | undefined;
    const modeIdForPrompt: string | undefined = activeModeId;
    if (activeMode && activeModeId && activeModeId !== 'default-assistant') {
      if (activeModeId === 'free-mode') {
        customSystemPrompt = '';
      } else {
        const promptLang =
          (ragParams.systemPromptLanguage as 'fr' | 'en') || lang;
        customSystemPrompt = activeMode.systemPrompt[promptLang];
      }
    }
    setChatSettings({
      modeId: modeIdForPrompt,
      customSystemPrompt,
      retrieval,
    });
  }, [ragParams, activeMode, activeModeId, lang, setChatSettings]);
}
