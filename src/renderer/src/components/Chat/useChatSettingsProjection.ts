/**
 * useChatSettingsProjection
 *
 * Shared hook that projects the renderer's `ragQueryStore.params` +
 * `modeStore.activeMode` onto `chatStore.chatSettings`, so every
 * `fusion:chat:start` (triggered from either Write or Brainstorm)
 * picks up the current filters / mode / custom prompt.
 *
 * Extracted during the fusion so every AssistantChat variant shares the same
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
    const panelPrompt = ragParams.useCustomSystemPrompt
      ? ragParams.customSystemPrompt?.trim()
      : undefined;
    if (activeModeId === 'free-mode') {
      // Mode libre : aucun prompt système, pas même celui du panneau.
      customSystemPrompt = '';
    } else if (panelPrompt) {
      // Le prompt personnalisé du panneau de chat remplace celui du mode —
      // c'est ce que sa case « Utiliser un prompt système personnalisé »
      // annonce. Il n'était jamais projeté : seul le texte du mode partait.
      customSystemPrompt = panelPrompt;
    } else if (activeMode && activeModeId && activeModeId !== 'default-assistant') {
      const promptLang =
        (ragParams.systemPromptLanguage as 'fr' | 'en') || lang;
      customSystemPrompt = activeMode.systemPrompt[promptLang];
    }
    setChatSettings({
      modeId: modeIdForPrompt,
      customSystemPrompt,
      retrieval,
    });
  }, [ragParams, activeMode, activeModeId, lang, setChatSettings]);
}
