// @vitest-environment jsdom
/**
 * `config.json` illisible, dans les Réglages : chaque section dit le motif, sans planter ni
 * tourner sans fin. Retirer un serveur ou délier un coffre échouait en silence : la réponse du
 * main n'était pas lue, et le rafraîchissement effaçait l'erreur (S11-1-8).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MCPClientsSection } from '../MCPClientsSection';
import { MCPServerSection } from '../MCPServerSection';
import { SecurityConfigSection } from '../SecurityConfigSection';
import { VaultConfigSection } from '../VaultConfigSection';
import { useDialogStore } from '../../../stores/dialogStore';

// Un `t` stable, comme le vrai : ces sections relisent l'état quand `t` change, et le simulacre
// commun en rend un nouveau à chaque rendu, ce qui tournerait sans fin sur une réponse réussie.
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr' } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

const REASON = ".cliodeck/config.json ne se lit pas : ce fichier n'a pas été modifié.";

afterEach(() => {
  cleanup();
  while (useDialogStore.getState().confirmOpen) useDialogStore.getState().resolveConfirm(false);
});

function installFusion(fusion: Record<string, unknown>): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = { ...w.electron, fusion };
}

const CLIENT = {
  name: 'europeana',
  transport: 'stdio',
  state: 'ready',
  tools: [],
  generation: 1,
};

describe('MCPClientsSection', () => {
  const installMcp = (remove: unknown) =>
    installFusion({
      mcp: {
        list: vi.fn().mockResolvedValue({ success: true, clients: [CLIENT] }),
        add: vi.fn(),
        remove,
        restart: vi.fn(),
        onEvent: () => () => undefined,
      },
    });

  it('retirer un serveur refusé : le motif s’affiche, et le serveur reste listé', async () => {
    const remove = vi.fn().mockResolvedValue({ success: false, error: REASON });
    installMcp(remove);
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));
    fireEvent.click(await screen.findByTitle('mcp.buttons.remove'));

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(remove).toHaveBeenCalledWith('europeana');
    expect(screen.getByText('europeana')).toBeTruthy();
  });

  it('retirer refusé parce qu’un autre projet s’est ouvert : une phrase, pas le code brut', async () => {
    installMcp(vi.fn().mockResolvedValue({ success: false, error: 'project-changed' }));
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));
    fireEvent.click(await screen.findByTitle('mcp.buttons.remove'));

    expect(await screen.findByText('hints.reasons.projectChanged')).toBeTruthy();
    expect(screen.queryByText('project-changed')).toBeNull();
  });

  it('retirer sans motif : un texte, pas de silence', async () => {
    installMcp(vi.fn().mockResolvedValue({ success: false }));
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));
    fireEvent.click(await screen.findByTitle('mcp.buttons.remove'));

    expect(await screen.findByText('mcp.errors.removeFailed')).toBeTruthy();
  });
});

describe('MCPClientsSection, sur un config.json illisible', () => {
  const installList = (list: unknown, add: unknown = vi.fn()) =>
    installFusion({
      mcp: {
        list,
        add,
        remove: vi.fn(),
        restart: vi.fn(),
        onEvent: () => () => undefined,
      },
    });

  it('liste refusée : le motif, jamais « aucun client configuré »', async () => {
    installList(vi.fn().mockResolvedValue({ success: false, error: REASON }));
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(screen.queryByText('mcp.empty')).toBeNull();
  });

  it('« Actualiser » redemande : le motif reste, puis la liste revient une fois le fichier réparé', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: REASON })
      .mockResolvedValueOnce({ success: false, error: REASON })
      .mockResolvedValue({ success: true, clients: [] });
    installList(list);
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));
    expect(await screen.findByText(REASON)).toBeTruthy();

    fireEvent.click(screen.getByText('mcp.buttons.refresh'));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.getByText(REASON)).toBeTruthy();
    expect(screen.queryByText('mcp.empty')).toBeNull();

    fireEvent.click(screen.getByText('mcp.buttons.refresh'));
    expect(await screen.findByText('mcp.empty')).toBeTruthy();
    expect(screen.queryByText(REASON)).toBeNull();
  });

  const fillAndSubmit = async (): Promise<void> => {
    fireEvent.click(await screen.findByText('mcp.buttons.addClient'));
    fireEvent.change(screen.getByPlaceholderText('mcp.form.namePlaceholder'), { target: { value: 'nouveau' } });
    fireEvent.change(screen.getByPlaceholderText('mcp.form.commandPlaceholder'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByText('mcp.buttons.save'));
  };

  it('ajout refusé : le motif s’affiche, et le formulaire reste avec ce qui a été saisi', async () => {
    const add = vi.fn().mockResolvedValue({ success: false, error: REASON });
    installList(vi.fn().mockResolvedValue({ success: true, clients: [] }), add);
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));
    expect(screen.queryByText(REASON)).toBeNull();

    await fillAndSubmit();

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(add).toHaveBeenCalledTimes(1);
    expect((screen.getByPlaceholderText('mcp.form.namePlaceholder') as HTMLInputElement).value).toBe('nouveau');
  });

  it('ajout refusé sans motif : un texte, pas de silence', async () => {
    const add = vi.fn().mockResolvedValue({ success: false });
    installList(vi.fn().mockResolvedValue({ success: true, clients: [] }), add);
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));

    await fillAndSubmit();

    expect(await screen.findByText('mcp.errors.addFailed')).toBeTruthy();
  });

  it('ajout refusé parce qu’un autre projet s’est ouvert : une phrase, pas le code brut', async () => {
    const add = vi.fn().mockResolvedValue({ success: false, error: 'project-changed' });
    installList(vi.fn().mockResolvedValue({ success: true, clients: [] }), add);
    render(<MCPClientsSection />);
    fireEvent.click(screen.getByText('mcp.title'));

    await fillAndSubmit();

    expect(await screen.findByText('hints.reasons.projectChanged')).toBeTruthy();
    expect(screen.queryByText('project-changed')).toBeNull();
  });
});

describe('VaultConfigSection', () => {
  const vault = (overrides: Record<string, unknown>) => ({
    status: vi.fn().mockResolvedValue({ success: true, indexed: true, dbPath: '/db', vaultPath: '/Notes' }),
    setPath: vi.fn(),
    unlink: vi.fn(),
    index: vi.fn(),
    onProgress: () => () => undefined,
    ...overrides,
  });

  it('état illisible : le motif, sans planter', async () => {
    installFusion({ vault: vault({ status: vi.fn().mockResolvedValue({ success: false, error: REASON }) }) });
    render(<VaultConfigSection />);
    fireEvent.click(screen.getByText('vault.title'));
    expect(await screen.findByText(REASON)).toBeTruthy();
    // Il y en a peut-être un dans ce fichier : ne pas dire qu'il n'y en a aucun.
    expect(screen.queryByText('vault.labels.noVaultLinked')).toBeNull();
  });

  it('délier refusé : le motif reste à l’écran, même si l’état se lit encore', async () => {
    const unlink = vi.fn().mockResolvedValue({ success: false, error: REASON });
    const status = vi.fn().mockResolvedValue({ success: true, indexed: true, dbPath: '/db', vaultPath: '/Notes' });
    installFusion({ vault: vault({ unlink, status }) });
    render(<VaultConfigSection />);
    fireEvent.click(screen.getByText('vault.title'));
    const button = await waitFor(() => {
      const found = screen.getByText('vault.buttons.unlink');
      expect(found.closest('button')?.disabled).toBe(false);
      return found;
    });

    fireEvent.click(button);
    await waitFor(() => expect(useDialogStore.getState().confirmOpen).toBe(true));
    useDialogStore.getState().resolveConfirm(true);

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(unlink).toHaveBeenCalledTimes(1);
  });
});

describe('MCPServerSection', () => {
  it('état illisible : le motif, sans planter ni rester vide', async () => {
    installFusion({
      mcpServer: {
        get: vi.fn().mockResolvedValue({ success: false, error: REASON }),
        set: vi.fn(),
        clients: vi.fn().mockResolvedValue({ success: true, platform: 'darwin' }),
        installExtension: vi.fn(),
        configureClaudeDesktop: vi.fn(),
      },
    });
    render(<MCPServerSection />);
    fireEvent.click(screen.getByText('mcpServer.title'));
    expect(await screen.findByText(REASON)).toBeTruthy();
  });
});

describe('SecurityConfigSection', () => {
  it('mode illisible : le motif, aucun choix affiché pour l’auteur, et ce qui s’applique est dit', async () => {
    installFusion({
      security: {
        getMode: vi.fn().mockResolvedValue({ success: false, error: REASON, appliedMode: 'warn' }),
        setMode: vi.fn(),
        getEvents: vi.fn().mockResolvedValue({
          success: true,
          stats: { total: 0, byKind: {}, bySeverity: { low: 0, medium: 0, high: 0 }, recent: [] },
        }),
        getUnreadableKeys: vi.fn().mockResolvedValue({ success: true, keys: [] }),
        getStorageStatus: vi.fn().mockResolvedValue({ success: true, encrypted: true, plaintextKeys: [] }),
        revokeAllKeys: vi.fn(),
      },
    });
    render(<SecurityConfigSection />);

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect(screen.getByText('security.inspection.modeUnreadable')).toBeTruthy();
    for (const value of ['warn', 'audit', 'block']) {
      const radio = screen.getByDisplayValue(value) as HTMLInputElement;
      expect(radio.checked).toBe(false);
      expect(radio.disabled).toBe(true);
    }
  });

  it('mode lisible : pas de message d’illisibilité, et le choix s’affiche', async () => {
    installFusion({
      security: {
        getMode: vi.fn().mockResolvedValue({ success: true, mode: 'warn' }),
        setMode: vi.fn(),
        getEvents: vi.fn().mockResolvedValue({
          success: true,
          stats: { total: 0, byKind: {}, bySeverity: { low: 0, medium: 0, high: 0 }, recent: [] },
        }),
        getUnreadableKeys: vi.fn().mockResolvedValue({ success: true, keys: [] }),
        getStorageStatus: vi.fn().mockResolvedValue({ success: true, encrypted: true, plaintextKeys: [] }),
        revokeAllKeys: vi.fn(),
      },
    });
    render(<SecurityConfigSection />);
    await waitFor(() => expect((screen.getByDisplayValue('warn') as HTMLInputElement).checked).toBe(true));
    expect(screen.queryByText('security.inspection.modeUnreadable')).toBeNull();
  });

  it('changer de mode refusé : le motif, et le mode revient', async () => {
    const setMode = vi.fn().mockResolvedValue({ success: false, error: REASON });
    installFusion({
      security: {
        getMode: vi.fn().mockResolvedValue({ success: true, mode: 'warn' }),
        setMode,
        getEvents: vi.fn().mockResolvedValue({
          success: true,
          stats: { total: 0, byKind: {}, bySeverity: { low: 0, medium: 0, high: 0 }, recent: [] },
        }),
        getUnreadableKeys: vi.fn().mockResolvedValue({ success: true, keys: [] }),
        getStorageStatus: vi.fn().mockResolvedValue({ success: true, encrypted: true, plaintextKeys: [] }),
        revokeAllKeys: vi.fn(),
      },
    });
    render(<SecurityConfigSection />);
    const block = (await screen.findByDisplayValue('block')) as HTMLInputElement;
    await waitFor(() => expect(block.disabled).toBe(false));

    fireEvent.click(block);

    expect(await screen.findByText(REASON)).toBeTruthy();
    expect((screen.getByDisplayValue('warn') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByDisplayValue('block') as HTMLInputElement).checked).toBe(false);
  });
});
