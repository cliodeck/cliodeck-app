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
  usePrimarySourcesStore.setState({ projectInfo: null, tpyPath: null, isSyncing: false, syncIssues: [] });
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

// L06-7 : une source enregistrée mais pas indexée décrit un état qui peut durer
// (Ollama arrêté) : pas d'alerte à chaque synchro, un avis dans le panneau.
describe('PrimarySourcesPanel — ce que la synchro n’a pas pu indexer', () => {
  it('« Synchroniser » : aucune alerte, le panneau dit combien de sources attendent leur indexation', async () => {
    tropy.sync.mockResolvedValue({ success: true, errors: [], issues: [{ code: 'embedding-failed', sources: 3 }] });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourcesPanel />);

    fireEvent.click(await screen.findByTitle('Synchroniser'));

    expect(
      await screen.findByText(/3 source\(s\) enregistrée\(s\), pas encore indexée\(s\)/)
    ).toBeInTheDocument();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('la synchro suivante, sans problème, retire l’avis', async () => {
    tropy.sync.mockResolvedValueOnce({ success: true, errors: [], issues: [{ code: 'no-embedding-provider', sources: 2 }] });
    render(<PrimarySourcesPanel />);
    fireEvent.click(await screen.findByTitle('Synchroniser'));
    expect(await screen.findByText(/2 source\(s\) enregistrée\(s\), pas encore indexée\(s\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Synchroniser'));
    await waitFor(() => expect(screen.queryByText(/pas encore indexée/)).toBeNull());
  });
});

// G3 : une page passée d'un item OCRisé à l'autre. Les deux sources attendent
// la passe d'OCR suivante, sans forcer : un état qui dure jusqu'à elle.
describe('PrimarySourcesPanel — des sources aux pages changées dans Tropy', () => {
  it('« Synchroniser » : aucune alerte, le panneau dit combien de sources attendent l’OCR', async () => {
    tropy.sync.mockResolvedValue({ success: true, errors: [], issues: [{ code: 'pages-changed', sources: 2 }] });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourcesPanel />);

    fireEvent.click(await screen.findByTitle('Synchroniser'));

    expect(await screen.findByText(/les pages de 2 source\(s\) ont changé dans Tropy/)).toBeInTheDocument();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('les trois langues citent les libellés exacts du bouton et de la case de la modale OCR', () => {
    for (const lng of ['fr', 'en', 'de']) {
      const strings = locale(lng).primarySources;
      const forceLabel = (strings.forceOCR as string).split(' (')[0];
      const banner = strings.issues.pagesChanged as string;
      expect(banner, lng).toContain('{{sources}}');
      expect(banner, lng).toContain(strings.runOCR);
      expect(banner, lng).toContain(forceLabel);
      expect(strings.pagesChanged as string, lng).toContain(strings.runOCR);
    }
  });

  // L'aide de la case disait « Décochée, ne traite que les sources sans
  // transcription » : les sources à reprendre, qui en ont une, l'étaient aussi.
  it('l’aide de la case « Relancer… » nomme les sources reprises sans elle, dans les trois langues', () => {
    for (const lng of ['fr', 'en', 'de']) {
      const hint = locale(lng).primarySources.forceOCRHint as string;
      expect(hint, lng).toContain('Poppler');
      expect(hint, lng).toContain('Tropy');
    }
  });
});
