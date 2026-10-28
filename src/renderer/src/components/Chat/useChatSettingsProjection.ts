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
import {
  useRAGQueryStore,
  getResolvedSourceType,
  resolveManuscriptToggle,
  resolveReadingNotesToggle,
} from '../../stores/ragQueryStore';
import { useWorkspaceModeStore } from '../../stores/workspaceModeStore';

export function useChatSettingsProjection(): void {
  const { i18n } = useTranslation('common');
  const lang = (i18n.language?.substring(0, 2) as 'fr' | 'en') || 'fr';
  const setChatSettings = useChatStore((s) => s.setChatSettings);
  const { activeMode, activeModeId } = useModeStore();
  const ragParams = useRAGQueryStore((s) => s.params);
  // The manuscript and reading-notes toggles are tri-states resolved against
  // the workspace (brainstorm → off by default): the effect must re-run when
  // the user switches workspace, not only when a toggle changes.
  const workspace = useWorkspaceModeStore((s) => s.active);

  useEffect(() => {
    // Resolve the three independent source toggles plus the EFFECTIVE
    // manuscript and reading-notes toggles into the (sourceType,
    // includeVault, includeManuscript, includeReadingNotes) bag understood by
    // the retrieval pipeline. When everything is off we still project a
    // permissive fallback so retrieval never silently breaks — the UI
    // surfaces the warning. Manuscript-only and notes-only are valid
    // selections (`sourceType: 'manuscript'` / `'readingNotes'`), never
    // widened.
    const manuscriptEffective = resolveManuscriptToggle(ragParams.includeManuscript, workspace);
    const readingNotesEffective = resolveReadingNotesToggle(ragParams.includeReadingNotes, workspace);
    const resolved = getResolvedSourceType(ragParams, manuscriptEffective, readingNotesEffective);
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
      includeManuscript: resolved.includeManuscript,
      includeReadingNotes: resolved.includeReadingNotes,
    };
    // Le sélecteur du panneau décide ; à défaut, la langue de l'interface.
    // Cette langue part au main à chaque tour : elle ne servait qu'aux modes
    // autres que le mode par défaut, dont le texte restait en français.
    const promptLanguage: 'fr' | 'en' =
      ragParams.systemPromptLanguage === 'fr' || ragParams.systemPromptLanguage === 'en'
        ? ragParams.systemPromptLanguage
        : lang === 'en'
          ? 'en'
          : 'fr';
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
      customSystemPrompt = activeMode.systemPrompt[promptLanguage];
    }
    setChatSettings({
      modeId: modeIdForPrompt,
      customSystemPrompt,
      promptLanguage,
      retrieval,
    });
  }, [ragParams, workspace, activeMode, activeModeId, lang, setChatSettings]);
}
