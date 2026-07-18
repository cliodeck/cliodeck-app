// @vitest-environment jsdom
/**
 * AssistantChat (ex-BrainstormChat) : settings toggle reveals ModeSelector
 * + RAGSettingsPanel and writes to the shared chatStore.chatSettings via
 * the projection hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Mock heavy inner panels — we only care about mount + store projection.
vi.mock('../ModeSelector', () => ({
  ModeSelector: () => <div data-testid="mode-selector-stub" />,
}));
vi.mock('../RAGSettingsPanel', () => ({
  RAGSettingsPanel: () => <div data-testid="rag-settings-stub" />,
}));
// Avoid stray IPC from useBrainstormChat.
vi.mock('../../Brainstorm/useBrainstormChat', () => ({
  useBrainstormChat: () => ({
    send: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    isStreaming: false,
    error: null,
  }),
}));

import { AssistantChat } from '../AssistantChat';
import { useChatStore } from '../../../stores/chatStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';

describe('AssistantChat settings panel', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    // AssistantChat lit window.electron.config.get('llm') au montage
    // (garde de consentement + modèle actif) — le mock minimal évite le crash.
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
  });
  afterEach(() => {
    cleanup();
  });

  it('toggle reveals ModeSelector + RAGSettingsPanel', () => {
    render(<AssistantChat variant="full" />);
    expect(screen.queryByTestId('rag-settings-stub')).toBeNull();
    const btn = screen.getByTestId('brainstorm-settings-toggle');
    fireEvent.click(btn);
    expect(screen.getByTestId('rag-settings-stub')).toBeTruthy();
    expect(screen.getByTestId('mode-selector-stub')).toBeTruthy();
  });

  it('projection hook syncs ragQueryStore.params into chatStore.chatSettings', () => {
    render(<AssistantChat variant="full" />);
    // Primary-only: bibliography + notes off, primary on — resolver should
    // project `sourceType: 'primary'` with vault disabled.
    act(() => {
      useRAGQueryStore.getState().setParams({
        topK: 17,
        includeBibliography: false,
        includePrimary: true,
        includeNotes: false,
      });
    });
    const settings = useChatStore.getState().chatSettings;
    expect(settings.retrieval?.topK).toBe(17);
    expect(settings.retrieval?.sourceType).toBe('primary');
    expect(settings.retrieval?.includeVault).toBe(false);
  });

  it('projection maps bibliography+notes → secondary + includeVault', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      useRAGQueryStore.getState().setParams({
        includeBibliography: true,
        includePrimary: false,
        includeNotes: true,
      });
    });
    const settings = useChatStore.getState().chatSettings;
    expect(settings.retrieval?.sourceType).toBe('secondary');
    expect(settings.retrieval?.includeVault).toBe(true);
  });
});
