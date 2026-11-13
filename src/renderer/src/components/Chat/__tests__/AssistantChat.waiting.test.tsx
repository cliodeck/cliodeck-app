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

/**
 * Le tour vit hors du composant depuis L09-6 : quitter l'onglet Chat (Journal, Idées, changement de
 * mode) démonte AssistantChat, la réponse continue. L'attente doit se lire sur le tour, pas sur
 * l'instance : le statut `generating` n'est émis qu'une fois par tour, et l'instance remontée ne le
 * reverra pas (S16-1-0).
 */
describe('AssistantChat — l’attente se lit sur le tour, pas sur l’instance (S16-1-0)', () => {
  type StatusEnv = { sessionId: string; status: { phase: string; label?: string } };
  const statusListeners: Array<(env: StatusEnv) => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    streaming = true;
    statusListeners.length = 0;
    useChatStore.getState().reset();
    useRAGQueryStore.getState().setParams({ timeout: 600_000 });
    (window as unknown as { electron: unknown }).electron = {
      config: { get: vi.fn(async () => null) },
      fusion: {
        chat: {
          onStatus: (cb: (env: StatusEnv) => void) => {
            statusListeners.push(cb);
            return () => {
              const i = statusListeners.indexOf(cb);
              if (i >= 0) statusListeners.splice(i, 1);
            };
          },
        },
      },
    };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const statusText = (): string => screen.queryByRole('status')?.textContent ?? '';

  it('quitter l’onglet et revenir pendant la réponse : pas de « lit encore le prompt »', () => {
    const aId = useChatStore.getState().beginAssistant('s-1');
    render(<AssistantChat variant="full" />);
    act(() => {
      for (const cb of [...statusListeners]) cb({ sessionId: 's-1', status: { phase: 'generating' } });
      useChatStore.getState().appendDelta(aId, 'Début de réponse ');
    });
    // Journal, puis retour sur Chat.
    cleanup();
    render(<AssistantChat variant="full" />);
    for (let s = 0; s < 65; s++) {
      act(() => {
        vi.advanceTimersByTime(1_000);
        useChatStore.getState().appendDelta(aId, 'mot ');
      });
    }

    expect(useChatStore.getState().messages[0].content).toContain('Début de réponse mot');
    expect(statusText()).not.toContain('chat.waitingForModel');
  });

  it('témoin : avant le premier jeton, le retour sur l’onglet n’efface pas l’attente', () => {
    useChatStore.getState().beginAssistant('s-1');
    render(<AssistantChat variant="full" />);
    cleanup();
    render(<AssistantChat variant="full" />);
    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    expect(statusText()).toContain('chat.waitingForModel');
  });

  it('compte l’attente depuis l’envoi, pas depuis le retour sur l’onglet', () => {
    useChatStore.getState().beginAssistant('s-1');
    // Le modèle lit le prompt pendant que l'historien est sur un autre onglet.
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    render(<AssistantChat variant="full" />);
    act(() => {
      vi.advanceTimersByTime(11_000);
    });

    expect(statusText()).toContain('chat.waitingForModel');
  });
});
