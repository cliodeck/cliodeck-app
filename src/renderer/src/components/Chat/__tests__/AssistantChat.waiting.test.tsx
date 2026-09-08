// @vitest-environment jsdom
/**
 * Avant le premier jeton, l'utilisateur doit savoir qu'il attend, depuis
 * combien de temps, et quand le délai d'inactivité coupera. Ollama ne
 * transmet pas l'avancement de la lecture du prompt ; le compteur est tout
 * ce que l'on peut afficher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

vi.mock('../ModeSelector', () => ({ ModeSelector: () => <div /> }));
vi.mock('../RAGSettingsPanel', () => ({ RAGSettingsPanel: () => <div /> }));
let streaming = true;
vi.mock('../../Brainstorm/useBrainstormChat', () => ({
  useBrainstormChat: () => ({
    send: vi.fn(),
    cancel: vi.fn(),
    reset: vi.fn(),
    isStreaming: streaming,
    error: null,
  }),
}));

import { AssistantChat } from '../AssistantChat';
import { useChatStore } from '../../../stores/chatStore';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';

describe('AssistantChat — compteur d’attente avant le premier jeton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    streaming = true;
    useChatStore.getState().reset();
    useRAGQueryStore.getState().setParams({ timeout: 600_000 });
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
    };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('n’affiche rien la première minute, puis le temps écoulé et la limite', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(screen.queryByText(/chat\.waitingForModel/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    // Le mock de react-i18next renvoie la clé quand des variables sont passées.
    expect(screen.getByRole('status').textContent).toContain('chat.waitingForModel');
  });

  it('se tait dès que le flux n’est plus en cours', () => {
    render(<AssistantChat variant="full" />);
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole('status').textContent).toContain('chat.waitingForModel');
    cleanup();
    streaming = false;
    render(<AssistantChat variant="full" />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
