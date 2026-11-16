// @vitest-environment jsdom
/**
 * Ajouter un serveur MCP refusé par le main : la section disait le code brut du refus
 * (`mcp_add_rejected:sse_url_invalid`). Depuis L04-9, une adresse SSE saisie sans `http://` est
 * refusée avant tout dialogue, et un serveur SSE pose la question comme un serveur stdio : ces deux
 * refus se disent par une phrase. Les autres motifs restent en code brut jusqu'à L12-8.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MCPClientsSection } from '../MCPClientsSection';

// Un `t` stable, comme le vrai : la section relit la liste quand `t` change.
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr' } }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

afterEach(() => {
  cleanup();
});

function installAdd(add: unknown): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    fusion: {
      mcp: {
        list: vi.fn().mockResolvedValue({ success: true, clients: [] }),
        add,
        remove: vi.fn(),
        restart: vi.fn(),
        onEvent: () => () => undefined,
      },
    },
  };
}

async function addSse(url: string): Promise<void> {
  render(<MCPClientsSection />);
  fireEvent.click(screen.getByText('mcp.title'));
  fireEvent.click(await screen.findByText('mcp.buttons.addClient'));
  fireEvent.change(screen.getByPlaceholderText('mcp.form.namePlaceholder'), { target: { value: 'distant' } });
  fireEvent.change(screen.getByDisplayValue('mcp.form.transportStdio'), { target: { value: 'sse' } });
  fireEvent.change(screen.getByPlaceholderText('mcp.form.urlPlaceholder'), { target: { value: url } });
  fireEvent.click(screen.getByText('mcp.buttons.save'));
}

describe('MCPClientsSection — refus d’un ajout', () => {
  it('une adresse SSE sans http(s) : une phrase, pas le code brut', async () => {
    const add = vi.fn().mockResolvedValue({ success: false, error: 'mcp_add_rejected:sse_url_invalid' });
    installAdd(add);

    await addSse('localhost:8080/sse');

    expect(await screen.findByText('mcp.errors.sseUrlInvalid')).toBeTruthy();
    expect(screen.queryByText('mcp_add_rejected:sse_url_invalid')).toBeNull();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ transport: 'sse', url: 'localhost:8080/sse' }));
  });

  it('la question refusée : une phrase, pas le code brut', async () => {
    installAdd(vi.fn().mockResolvedValue({ success: false, error: 'mcp_add_rejected:user_cancelled' }));

    await addSse('http://127.0.0.1:9/sse');

    expect(await screen.findByText('mcp.errors.userCancelled')).toBeTruthy();
    expect(screen.queryByText('mcp_add_rejected:user_cancelled')).toBeNull();
  });

  it('témoin : un autre motif reste affiché tel quel', async () => {
    installAdd(vi.fn().mockResolvedValue({ success: false, error: 'mcp_add_rejected:name_taken' }));

    await addSse('http://127.0.0.1:9/sse');

    expect(await screen.findByText('mcp_add_rejected:name_taken')).toBeTruthy();
  });
});
