// @vitest-environment jsdom
/**
 * Panneau Sources primaires : ouvrir un autre projet Tropy (L06-3, Q25).
 *
 * Un projet ClioDeck ne se lie qu'à un projet Tropy. Quand le main refuse un
 * autre `.tropy`, le panneau doit le dire en nommant les deux projets et en
 * renvoyant à la purge, là où elle est vraiment (panneau Projet, section
 * « Actions »), sans lancer la synchro automatique qui suivait l'ouverture.
 * L'alerte disait « Failed to open Tropy project: … », en anglais, sans rien
 * de tout cela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as fs from 'fs';
import * as path from 'path';
import { PrimarySourcesPanel } from '../PrimarySourcesPanel';
import { usePrimarySourcesStore } from '../../../stores/primarySourcesStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useDialogStore } from '../../../stores/dialogStore';

// Les vraies chaînes françaises, interpolées : le message doit nommer les deux
// projets et citer les libellés exacts de l'interface.
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
  return {
    useTranslation: () => ({ t: instance.t.bind(instance), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

const LOCALES = path.join(__dirname, '../../../../../../public/locales');
const locale = (lng: string) => JSON.parse(fs.readFileSync(path.join(LOCALES, lng, 'common.json'), 'utf-8'));

const DIFFERENT = {
  code: 'different-project',
  linkedName: 'Grèves nantaises',
  candidateName: 'Comité',
  sourceCount: 25,
};

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    openProject: vi.fn(async () => ({ success: false, error: 'different-project', issue: DIFFERENT })),
    sync: vi.fn(async () => ({ success: true, errors: [], issues: [] })),
    getProjectInfo: vi.fn(async () => ({
      success: true,
      info: { name: 'Grèves nantaises', itemCount: 25, lastModified: '', isWatching: false, tpyPath: '/A.tropy' },
    })),
    getAllSources: vi.fn(async () => ({ success: true, sources: [] })),
    getStatistics: vi.fn(async () => ({ success: false })),
    getOCRLanguages: vi.fn(async () => ({ success: true, languages: [] })),
    onSyncProgress: vi.fn(() => () => undefined),
  };
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.tropy = tropy;
  electron.dialog = { openFile: async () => ({ canceled: false, filePaths: ['/Archives/Comité.tropy'] }) };
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: 'Thèse',
      path: '/p/these',
      type: 'article',
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useProjectStore.setState({ currentProject: null });
  usePrimarySourcesStore.setState({ projectInfo: null, tpyPath: null, isSyncing: false });
});

describe('PrimarySourcesPanel — un autre projet Tropy', () => {
  it('openProject répond different-project : alerte qui nomme les deux projets, aucune synchro', async () => {
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourcesPanel />);

    fireEvent.click(screen.getByTitle('Ouvrir un projet Tropy'));
    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));

    const message = showAlert.mock.calls[0][0];
    expect(message).toContain('« Comité »');
    expect(message).toContain('« Grèves nantaises »');
    expect(message).toContain('25');
    // L'endroit réel de la purge, avec les libellés de l'interface.
    expect(message).toContain('panneau Projet');
    expect(message).toContain(`« ${locale('fr').actions.title} »`);
    expect(message).toContain(`« ${locale('fr').actions.purgePrimaryDatabase.button} »`);
    expect(message).not.toMatch(/Failed to open/);

    expect(tropy.sync).not.toHaveBeenCalled();
    expect(usePrimarySourcesStore.getState().tpyPath).toBe('/A.tropy');
  });

  it('« Synchroniser » refusé pour la même raison : l’alerte le dit aussi', async () => {
    tropy.sync.mockResolvedValue({ success: false, errors: ['Different Tropy project'], issues: [DIFFERENT] });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourcesPanel />);

    fireEvent.click(await screen.findByTitle('Synchroniser'));
    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));
    expect(showAlert.mock.calls[0][0]).toContain('« Grèves nantaises »');
  });

  it('les trois langues citent les libellés exacts de la section et du bouton de purge', () => {
    for (const lng of ['fr', 'en', 'de']) {
      const strings = locale(lng);
      for (const key of ['differentProject', 'differentProjectUnnamed']) {
        const message = strings.primarySources.issues[key] as string;
        expect(message, `${lng} ${key}`).toContain(strings.actions.title);
        expect(message, `${lng} ${key}`).toContain(strings.actions.purgePrimaryDatabase.button);
        expect(message, `${lng} ${key}`).toContain('{{candidateName}}');
        expect(message, `${lng} ${key}`).toContain('{{sourceCount}}');
      }
      expect(strings.primarySources.issues.differentProject).toContain('{{linkedName}}');
    }
  });
});
