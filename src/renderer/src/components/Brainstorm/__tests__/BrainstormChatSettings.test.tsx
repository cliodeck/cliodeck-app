// @vitest-environment jsdom
/**
 * BrainstormChat: settings toggle reveals ModeSelector + RAGSettingsPanel
 * and writes to the shared chatStore.chatSettings via the projection hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';

// Mock heavy inner panels — we only care about mount + store projection.
vi.mock('../../Chat/ModeSelector', () => ({
  ModeSelector: () => <div data-testid="mode-selector-stub" />,
}));
vi.mock('../../Chat/RAGSettingsPanel', () => ({
  RAGSettingsPanel: () => <div data-testid="rag-settings-stub" />,
}));
// Avoid stray IPC from useBrainstormChat.
vi.mock('../useBrainstormChat', () => ({
  useBrainstormChat: () => ({
    send: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    isStreaming: false,
    error: null,
  }),
}));

import { BrainstormChat } from '../BrainstormChat';
import { useChatStore } from '../../../stores/chatStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';

describe('BrainstormChat settings panel', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('toggle reveals ModeSelector + RAGSettingsPanel', () => {
    render(<BrainstormChat />);
    expect(screen.queryByTestId('rag-settings-stub')).toBeNull();
    const btn = screen.getByTestId('brainstorm-settings-toggle');
    fireEvent.click(btn);
    expect(screen.getByTestId('rag-settings-stub')).toBeTruthy();
    expect(screen.getByTestId('mode-selector-stub')).toBeTruthy();
  });

  it('projection hook syncs ragQueryStore.params into chatStore.chatSettings', () => {
    render(<BrainstormChat />);
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
    render(<BrainstormChat />);
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
