// @vitest-environment jsdom
/**
 * « Importer depuis Obsidian » refusé par le main (config.json illisible, aucun coffre lié) : le
 * bouton ne faisait rien, sans un mot, et les codes du main ne doivent pas se lire tels quels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IdeasPanel } from '../IdeasPanel';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useProjectStore } from '../../../stores/projectStore';

const toasts = () => useNotificationStore.getState().notifications;

function openPanel(result: unknown): void {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = {
    ...w.electron,
    fusion: { vault: { importAsIdeas: vi.fn().mockResolvedValue(result) } },
  };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Danzig',
      path: '/tmp/danzig',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
  render(<IdeasPanel />);
}

afterEach(() => {
  cleanup();
  useNotificationStore.getState().dismissAll();
});

describe('IdeasPanel : import depuis le coffre refusé', () => {
  it('config.json illisible : le motif s’affiche', async () => {
    const reason = ".cliodeck/config.json ne se lit pas : ce fichier n'a pas été modifié.";
    openPanel({ success: false, error: reason });

    fireEvent.click(screen.getByTitle('ideas.importObsidian'));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ level: 'error', title: 'ideas.importFailed', message: reason });
  });

  it('aucun coffre lié : un texte, jamais le code', async () => {
    openPanel({ success: false, error: 'no_vault_configured' });

    fireEvent.click(screen.getByTitle('ideas.importObsidian'));

    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].message).toBe('ideas.importNoVault');
  });
});
