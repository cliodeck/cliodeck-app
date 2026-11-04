// @vitest-environment jsdom
/**
 * Les paramètres Zotero du projet : ils disent le refus du main, et n'envoient que ce que
 * l'auteur a changé.
 *
 * Le panneau affichait « Enregistré » sans lire la réponse, et envoyait tout le bloc chargé plus
 * tôt : la collection qu'une synchronisation venait de poser s'effaçait, et la synchronisation
 * suivante repartait de l'ancienne.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react';

import { ZoteroProjectSettings } from '../ZoteroProjectSettings';

const PROJECT = '/p/these';
const PROJECT_FILE = `${PROJECT}/project.json`;

let updateConfig: ReturnType<typeof vi.fn>;
let getConfig: ReturnType<typeof vi.fn>;

async function mount(mode: 'api' | 'local', stored: Record<string, unknown> | null): Promise<RenderResult> {
  getConfig.mockResolvedValue(stored ? { zotero: stored } : stored);
  (window as unknown as { electron: unknown }).electron = {
    config: { get: vi.fn(async () => ({ mode, dataDirectory: '/z' })) },
    project: { getConfig, updateConfig },
    zotero: {
      listLibraries: vi.fn(async () => ({
        success: true,
        libraries: [
          { libraryID: 3, type: 'group', name: 'Groupe A' },
          { libraryID: 4, type: 'group', name: 'Groupe B' },
        ],
      })),
    },
  };
  let view: RenderResult | undefined;
  await act(async () => {
    view = render(<ZoteroProjectSettings projectPath={PROJECT} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByText('project.zoteroSettings'));
  });
  return view as RenderResult;
}

const type = (placeholder: string, value: string) =>
  act(async () => {
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
  });

const save = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }));
  });

beforeEach(() => {
  updateConfig = vi.fn(async () => ({ success: true }));
  getConfig = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('la réponse du main', () => {
  it('refus : « non enregistré » reste affiché, jamais « enregistré »', async () => {
    updateConfig.mockResolvedValue({ success: false, error: 'Unexpected token' });
    await mount('api', { groupId: '1', collectionKey: 'X' });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();

    expect(screen.getByText('project.zoteroNotSaved')).toHaveClass('error');
    expect(screen.queryByText('settings.saved')).toBeNull();
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });

  it('une réponse qui ne dit pas le succès n’en est pas un', async () => {
    updateConfig.mockResolvedValue(undefined);
    await mount('api', { groupId: '1' });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();

    expect(screen.getByText('project.zoteroNotSaved')).toBeInTheDocument();
    expect(screen.queryByText('settings.saved')).toBeNull();
  });

  it('rejet de l’appel : l’erreur s’affiche', async () => {
    updateConfig.mockRejectedValue(new Error('validation'));
    await mount('api', { groupId: '1' });

    await save();

    expect(screen.getByText('settings.saveError')).toHaveClass('error');
  });

  it('succès : « enregistré »', async () => {
    await mount('api', { groupId: '1' });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();

    expect(screen.getByText('settings.saved')).toBeInTheDocument();
  });

  it('un refus, puis une nouvelle tentative : le champ change toujours, et part encore', async () => {
    updateConfig.mockResolvedValueOnce({ success: false });
    await mount('api', { groupId: '1' });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();
    await save();

    expect(updateConfig).toHaveBeenCalledTimes(2);
    expect(updateConfig).toHaveBeenLastCalledWith(PROJECT_FILE, { zotero: { groupId: '2' } });
  });
});

describe('seul ce que l’auteur a changé part', () => {
  it('une autre bibliothèque : ni la collection, ni le reste', async () => {
    await mount('local', { collectionKey: 'X', libraryID: 3 });

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } });
    });
    await save();

    expect(updateConfig).toHaveBeenCalledWith(PROJECT_FILE, { zotero: { libraryID: 4 } });
  });

  it('un autre groupe : la collection reste au disque', async () => {
    await mount('api', { groupId: '1', collectionKey: 'X', libraryID: 3 });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();

    expect(updateConfig).toHaveBeenCalledWith(PROJECT_FILE, { zotero: { groupId: '2' } });
  });

  it('une autre collection, choisie par l’auteur : elle part', async () => {
    await mount('api', { groupId: '1', collectionKey: 'X' });

    await type('project.zoteroCollectionKeyPlaceholder', 'Z');
    await save();

    expect(updateConfig).toHaveBeenCalledWith(PROJECT_FILE, { zotero: { collectionKey: 'Z' } });
  });

  it('une collection vidée : elle s’efface, explicitement', async () => {
    await mount('api', { groupId: '1', collectionKey: 'X' });

    await type('project.zoteroCollectionKeyPlaceholder', '');
    await save();

    const sent = updateConfig.mock.calls[0]?.[1] as { zotero: Record<string, unknown> };
    expect(sent.zotero).toHaveProperty('collectionKey', undefined);
    expect(Object.keys(sent.zotero)).toEqual(['collectionKey']);
  });

  it('rien de changé : aucune clé ne part', async () => {
    await mount('local', { collectionKey: 'X', libraryID: 3 });

    await save();

    expect(updateConfig).toHaveBeenCalledWith(PROJECT_FILE, { zotero: {} });
  });

  it('un second enregistrement ne renvoie pas ce qui est déjà parti', async () => {
    await mount('api', { groupId: '1', collectionKey: 'X' });

    await type('project.zoteroGroupIdPlaceholder', '2');
    await save();
    await save();

    expect(updateConfig).toHaveBeenLastCalledWith(PROJECT_FILE, { zotero: {} });
  });

  it('project.json illisible au montage : les champs saisis partent, et le refus se dit', async () => {
    updateConfig.mockResolvedValue({ success: false, error: 'illisible' });
    await mount('api', null);

    await type('project.zoteroCollectionKeyPlaceholder', 'Z');
    await save();

    expect(updateConfig).toHaveBeenCalledWith(PROJECT_FILE, { zotero: { collectionKey: 'Z' } });
    expect(screen.getByText('project.zoteroNotSaved')).toBeInTheDocument();
  });

  it('un autre projet : les champs du précédent ne le suivent pas', async () => {
    const { rerender } = await mount('api', { groupId: '1', collectionKey: 'X' });
    expect(screen.getByPlaceholderText('project.zoteroCollectionKeyPlaceholder')).toHaveValue('X');
    getConfig.mockResolvedValue({ name: 'Sans Zotero' });

    await act(async () => {
      rerender(<ZoteroProjectSettings projectPath="/p/autre" />);
    });

    expect(screen.getByPlaceholderText('project.zoteroCollectionKeyPlaceholder')).toHaveValue('');
  });
});
