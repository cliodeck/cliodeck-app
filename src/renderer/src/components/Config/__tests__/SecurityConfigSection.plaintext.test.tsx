// @vitest-environment jsdom
/**
 * Repli en clair (ADR 0006, dette n° 16) : sans trousseau système, les clés
 * API sont écrites non chiffrées. Seule une ligne de console au démarrage le
 * disait ; Réglages → Sécurité doit l'afficher.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { SecurityConfigSection } from '../SecurityConfigSection';

afterEach(() => cleanup());

function installSecurityApi(status: { encrypted: boolean; plaintextKeys: string[] }): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    fusion: {
      security: {
        getMode: vi.fn().mockResolvedValue({ success: true, mode: 'warn' }),
        setMode: vi.fn(),
        getEvents: vi.fn().mockResolvedValue({
          success: true,
          stats: { total: 0, byKind: {}, bySeverity: { low: 0, medium: 0, high: 0 }, recent: [] },
        }),
        getUnreadableKeys: vi.fn().mockResolvedValue({ success: true, keys: [] }),
        getStorageStatus: vi.fn().mockResolvedValue({ success: true, ...status }),
        revokeAllKeys: vi.fn(),
      },
    },
  };
}

describe('SecurityConfigSection — clés stockées en clair', () => {
  it('avertit et liste les clés quand le trousseau est indisponible', async () => {
    installSecurityApi({ encrypted: false, plaintextKeys: ['llm.mistralAPIKey', 'zotero.apiKey'] });
    render(<SecurityConfigSection />);

    const block = await screen.findByTestId('plaintext-keys');
    expect(block.textContent).toContain('security.plaintext.title');
    expect(block.textContent).toContain('llm.mistralAPIKey');
    expect(block.textContent).toContain('zotero.apiKey');
    expect(block.textContent).toContain('security.plaintext.remedy');
  });

  it('avertit aussi sans clé enregistrée : les prochaines le seront en clair', async () => {
    installSecurityApi({ encrypted: false, plaintextKeys: [] });
    render(<SecurityConfigSection />);

    const block = await screen.findByTestId('plaintext-keys');
    expect(block.textContent).toContain('security.plaintext.none');
  });

  it('ne dit rien quand le trousseau chiffre les clés', async () => {
    installSecurityApi({ encrypted: true, plaintextKeys: [] });
    render(<SecurityConfigSection />);

    await waitFor(() => {
      const w = window as unknown as {
        electron: { fusion: { security: { getUnreadableKeys: ReturnType<typeof vi.fn> } } };
      };
      expect(w.electron.fusion.security.getUnreadableKeys).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('plaintext-keys')).toBeNull();
  });
});
