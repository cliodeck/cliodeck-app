// @vitest-environment jsdom
/**
 * « Importer depuis le vault Obsidian » dit toujours ce qu'il a fait (S16-1-16).
 *
 * Le bouton se désactivait un instant, puis rien : un vault dont le dossier a disparu donnait la
 * phrase anglaise du main, un appel rejeté n'allait qu'à la console, et un import réussi ne disait
 * pas combien de notes il avait ajoutées. Un vault vide, ou déjà importé, ressemblait à un bouton
 * qui ne marche pas.
 *
 * Vrai panneau, vrai magasin, vraies locales françaises. Le main est imité dans la forme qu'il
 * répond : un refus codé (`errorCode`, relatif à `messages.*`) ou une cause brute. Reprend les deux
 * cas de `IdeasPanel.import-refused.test.tsx` (config.json illisible, aucun vault lié), qui
 * lisaient les clés seules : un refus codé se traduit, et seules les vraies locales le montrent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const fr = (await import('../../../../../../public/locales/fr/common.json')).default;
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: { fr: { common: fr } },
    interpolation: { escapeValue: false },
  });
  const t = instance.t.bind(instance);
  return {
    useTranslation: () => ({ t, i18n: { language: 'fr' } }),
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { IdeasPanel } from '../IdeasPanel';
import { useIdeaStore, type Idea } from '../../../stores/ideaStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useProjectStore } from '../../../stores/projectStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

const PROJECT = '/tmp/danzig';
const toasts = () => useNotificationStore.getState().notifications;
const initialStore = useIdeaStore.getState();
let saveIdeas: ReturnType<typeof vi.fn>;

const note = (title: string) => ({ title, content: `Note ${title}.`, tags: [], wikilinks: [], notePath: `${title}.md` });

const fromVault = (title: string): Idea => ({
  id: `idee-${title}`,
  title,
  content: '',
  tags: [],
  links: [],
  origin: { type: 'obsidian', notePath: `${title}.md` },
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
});

async function importWith(importAsIdeas: ReturnType<typeof vi.fn>, ideas: Idea[] = []): Promise<void> {
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = { ...w.electron, fusion: { vault: { importAsIdeas } } };
  projectLifecycle.enter(PROJECT);
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Danzig',
      path: PROJECT,
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
  useIdeaStore.setState({ ideas, loadedFor: PROJECT, saveIdeas } as never);
  render(<IdeasPanel />);
  await act(async () => {
    fireEvent.click(screen.getByTitle('Importer depuis le vault Obsidian'));
  });
  await waitFor(() => expect(toasts()).toHaveLength(1));
}

beforeEach(() => {
  saveIdeas = vi.fn(async () => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  useNotificationStore.getState().dismissAll();
  useIdeaStore.setState(initialStore, true);
  vi.restoreAllMocks();
});

describe('IdeasPanel : un import refusé se dit, en français', () => {
  it('aucun vault lié : la phrase des locales, jamais le code', async () => {
    await importWith(
      vi.fn().mockResolvedValue({
        success: false,
        error: 'no_vault_configured',
        errorCode: 'vault.notConfigured',
      })
    );

    expect(toasts()[0]).toMatchObject({
      level: 'error',
      title: 'Import du vault impossible',
      message: "Aucun vault n'est lié à ce projet : liez-en un dans les Réglages.",
    });
  });

  it('le dossier du vault a disparu : le message le dit, chemin compris, et pas en anglais', async () => {
    await importWith(
      vi.fn().mockResolvedValue({
        success: false,
        error: 'vault path no longer exists',
        errorCode: 'vault.pathMissing',
        errorParams: { path: '/Volumes/Notes' },
      })
    );

    const message = toasts()[0].message ?? '';
    expect(toasts()[0].level).toBe('error');
    expect(message).toContain('/Volumes/Notes');
    expect(message).not.toContain('no longer exists');
  });

  it('une cause sans code (config.json illisible) : la cause du main, telle quelle', async () => {
    const reason = ".cliodeck/config.json ne se lit pas : ce fichier n'a pas été modifié.";
    await importWith(vi.fn().mockResolvedValue({ success: false, error: reason }));

    expect(toasts()[0]).toMatchObject({ level: 'error', title: 'Import du vault impossible', message: reason });
  });

  it('un appel rejeté : une notification, pas seulement la console', async () => {
    await importWith(vi.fn().mockRejectedValue(new Error('IPC rompu')));

    expect(toasts()[0]).toMatchObject({ level: 'error', title: 'Import du vault impossible', message: 'IPC rompu' });
  });
});

describe('IdeasPanel : un import réussi dit combien de notes il a ajoutées', () => {
  it('deux notes nouvelles : « 2 notes du vault ajoutées aux idées »', async () => {
    await importWith(vi.fn().mockResolvedValue({ success: true, ideas: [note('Gdansk'), note('Port franc')], count: 2 }));

    expect(useIdeaStore.getState().ideas.map((i) => i.title)).toEqual(['Gdansk', 'Port franc']);
    expect(toasts()[0].level).toBe('success');
    expect(toasts()[0].title).toContain('2');
    expect(saveIdeas).toHaveBeenCalledWith(PROJECT);
  });

  it('une note nouvelle sur deux : le compte est celui des notes ajoutées', async () => {
    await importWith(
      vi.fn().mockResolvedValue({ success: true, ideas: [note('Gdansk'), note('Port franc')], count: 2 }),
      [fromVault('Gdansk')]
    );

    expect(useIdeaStore.getState().ideas).toHaveLength(2);
    expect(toasts()[0].title).toContain('1');
    expect(toasts()[0].title).not.toContain('2');
  });

  it('rien de nouveau : le bouton le dit, au lieu de sembler ne rien faire', async () => {
    await importWith(vi.fn().mockResolvedValue({ success: true, ideas: [note('Gdansk')], count: 1 }), [
      fromVault('Gdansk'),
    ]);

    expect(useIdeaStore.getState().ideas).toHaveLength(1);
    expect(toasts()[0].level).toBe('info');
    expect(toasts()[0].title).not.toContain('Import du vault impossible');
  });
});
