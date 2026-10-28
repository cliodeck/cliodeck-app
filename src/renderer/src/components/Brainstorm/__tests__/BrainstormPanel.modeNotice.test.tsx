// @vitest-environment jsdom
/**
 * L'espace Brainstorm propose le mode de chat « Brainstorming » tant que
 * l'assistant par défaut est actif, et se souvient d'un refus
 * (`docs/poids-du-manuscrit.md`, décision 2). Changer de mode, lui, ne
 * retient rien : qui revient à l'assistant par défaut revoit la proposition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';

// Le chat réel entraîne ses propres magasins et le transport fusion:chat:* —
// hors sujet ici.
vi.mock('../../Chat/AssistantChat', () => ({
  AssistantChat: () => <div data-testid="assistant-chat-stub" />,
}));

import { BrainstormPanel } from '../BrainstormPanel';
import { useProjectStore } from '../../../stores/projectStore';
import { useModeStore } from '../../../stores/modeStore';

const FLAG = 'brainstormModeNoticeDismissed';
const MESSAGE = /cherche des idées dans vos sources/;
const ACTIVATE = 'Activer le mode Brainstorming';
const DISMISS = 'Ne plus proposer';

function installBridge(flag: boolean | undefined) {
  const configGet = vi.fn(async (key: string) => (key === FLAG ? flag : undefined));
  const configSet = vi.fn(async () => ({ success: true }));
  const modeSetActive = vi.fn(async () => ({ success: true }));
  (window as unknown as { electron: unknown }).electron = {
    fusion: {
      hints: {
        read: vi.fn(async () => ({
          success: true,
          hints: { present: false, raw: '', normalized: '', sourcePath: '.cliodeck/hints.md' },
        })),
      },
      recipes: { list: vi.fn(async () => ({ success: true, builtin: [], user: [] })) },
      vault: { status: vi.fn(async () => ({ success: true, indexed: false, dbPath: '' })) },
    },
    fs: { exists: vi.fn(async () => false) },
    config: { get: configGet, set: configSet },
    mode: { setActive: modeSetActive },
  };
  return { configGet, configSet, modeSetActive };
}

function openProject(): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Test',
      path: '/tmp/test-project',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
}

/** Laisse passer les promesses du pont et les effets qu'elles déclenchent. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const originalSetActiveMode = useModeStore.getState().setActiveMode;

beforeEach(() => {
  openProject();
  useModeStore.setState({
    activeModeId: 'default-assistant',
    activeMode: null,
    modes: [],
    setActiveMode: originalSetActiveMode,
  });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ currentProject: null });
});

describe('BrainstormPanel — proposition du mode « Brainstorming »', () => {
  it('propose le mode quand l’assistant par défaut est actif et que rien n’a été refusé', async () => {
    const bridge = installBridge(undefined);
    render(<BrainstormPanel />);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(MESSAGE);
    expect(screen.getByRole('button', { name: ACTIVATE })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DISMISS })).toBeInTheDocument();
    expect(bridge.configGet).toHaveBeenCalledWith(FLAG);
    // Afficher n'est pas refuser : rien n'est écrit.
    expect(bridge.configSet).not.toHaveBeenCalled();
  });

  it('ne propose rien quand le mode « Brainstorming » est déjà actif', async () => {
    const bridge = installBridge(undefined);
    useModeStore.setState({ activeModeId: 'brainstorming' });
    render(<BrainstormPanel />);

    await waitFor(() => expect(bridge.configGet).toHaveBeenCalledWith(FLAG));
    await flush();
    expect(screen.queryByText(MESSAGE)).toBeNull();
    expect(screen.getByTestId('assistant-chat-stub')).toBeInTheDocument();
  });

  it('ne revient pas quand la proposition a été refusée lors d’un lancement précédent', async () => {
    const bridge = installBridge(true);
    render(<BrainstormPanel />);

    await waitFor(() => expect(bridge.configGet).toHaveBeenCalledWith(FLAG));
    await flush();
    expect(screen.queryByText(MESSAGE)).toBeNull();
    expect(screen.getByTestId('assistant-chat-stub')).toBeInTheDocument();
  });

  it('« Ne plus proposer » retient le refus dans la configuration et retire la bannière', async () => {
    const bridge = installBridge(undefined);
    render(<BrainstormPanel />);
    await screen.findByText(MESSAGE);

    fireEvent.click(screen.getByRole('button', { name: DISMISS }));

    expect(bridge.configSet).toHaveBeenCalledWith(FLAG, true);
    expect(screen.queryByText(MESSAGE)).toBeNull();
    // Le mode de chat, lui, n'a pas bougé.
    expect(useModeStore.getState().activeModeId).toBe('default-assistant');
    expect(bridge.modeSetActive).not.toHaveBeenCalled();
  });

  it('« Activer » demande le mode « Brainstorming » au magasin, sans retenir de refus', async () => {
    const bridge = installBridge(undefined);
    const setActiveMode = vi.fn(async () => undefined);
    useModeStore.setState({ setActiveMode });
    render(<BrainstormPanel />);
    await screen.findByText(MESSAGE);

    fireEvent.click(screen.getByRole('button', { name: ACTIVATE }));

    expect(setActiveMode).toHaveBeenCalledWith('brainstorming');
    expect(bridge.configSet).not.toHaveBeenCalled();
  });

  it('une fois le mode changé, la bannière disparaît — et revient si l’on retourne à l’assistant par défaut', async () => {
    const bridge = installBridge(undefined);
    render(<BrainstormPanel />);
    await screen.findByText(MESSAGE);

    // Le vrai `setActiveMode` : il passe par l'IPC puis met le magasin à jour.
    fireEvent.click(screen.getByRole('button', { name: ACTIVATE }));

    await waitFor(() => expect(bridge.modeSetActive).toHaveBeenCalledWith('brainstorming'));
    await waitFor(() => expect(screen.queryByText(MESSAGE)).toBeNull());
    expect(useModeStore.getState().activeModeId).toBe('brainstorming');
    expect(bridge.configSet).not.toHaveBeenCalled();

    act(() => {
      useModeStore.setState({ activeModeId: 'default-assistant' });
    });
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });

  it('attend qu’un projet soit ouvert : sans projet, seule l’invite à en ouvrir un s’affiche', async () => {
    installBridge(undefined);
    useProjectStore.setState({ currentProject: null });
    render(<BrainstormPanel />);

    const notice = await screen.findByRole('status');
    await flush();
    expect(notice).not.toHaveTextContent(MESSAGE);
    expect(screen.queryByText(MESSAGE)).toBeNull();
  });
});
