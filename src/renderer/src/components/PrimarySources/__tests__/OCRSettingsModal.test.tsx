// @vitest-environment jsdom
/**
 * Modale OCR : ce qui a empêché la reconnaissance se dit dans le bilan de la
 * passe, traduit et selon le système, au lieu de « 1 erreur(s) — voir la
 * console » (L06-10). Poppler absent : la marche à suivre n'était qu'en
 * français, dans la console. Modèle de langue introuvable (hors ligne) : la
 * barre restait sur « Traitement 1/N » jusqu'au redémarrage.
 *
 * Vrais store et composant, vraies chaînes françaises ; seul le pont
 * `window.electron` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OCRSettingsModal } from '../OCRSettingsModal';
import { usePrimarySourcesStore } from '../../../stores/primarySourcesStore';
import { useDialogStore } from '../../../stores/dialogStore';

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

const USER_AGENTS = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ClioDeck Electron/45.0.0',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ClioDeck Electron/45.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ClioDeck Electron/45.0.0',
};

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    getAllSources: vi.fn(async () => ({ success: true, sources: [] })),
    getStatistics: vi.fn(async () => ({ success: true, statistics: null })),
    getProjectInfo: vi.fn(async () => ({ success: true, info: null })),
    getOCRLanguages: vi.fn(async () => ({
      success: true,
      languages: [
        { code: 'fra', name: 'Français' },
        { code: 'frk', name: 'Allemand Fraktur' },
      ],
    })),
    onSyncProgress: vi.fn(() => () => undefined),
    sync: vi.fn(async () => ({ success: true, errors: [], issues: [] })),
  };
  (window as unknown as { electron: Record<string, unknown> }).electron.tropy = tropy;
  usePrimarySourcesStore.setState({ isSyncing: false, availableOCRLanguages: [], ocrLanguage: 'fra' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePrimarySourcesStore.setState({ syncIssues: [], availableOCRLanguages: [] });
});

async function runWith(issues: unknown[], userAgent = USER_AGENTS.mac): Promise<void> {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  tropy.sync.mockResolvedValue({ success: true, transcriptionsWritten: 0, ocrPerformed: 0, errors: [], issues });
  render(<OCRSettingsModal isOpen onClose={() => undefined} />);
  await screen.findByRole('option', { name: 'Allemand Fraktur' });
  fireEvent.click(screen.getByRole('button', { name: /Lancer l'OCR/ }));
  await screen.findByText('Bilan de la passe');
}

describe('modale OCR : Poppler absent (L06-10, S08-1-34)', () => {
  it('macOS : la commande Homebrew, traduite, sans alerte ni « voir la console »', async () => {
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    await runWith([{ code: 'poppler-missing' }]);

    expect(screen.getByText(/Poppler est introuvable/)).toHaveTextContent('brew install poppler');
    // Le bouton à reprendre, nommé comme dans la modale : « relancez l'OCR »
    // se confondait avec la case qui refait tout le corpus (revue de L06-10).
    expect(screen.getByText(/Poppler est introuvable/)).toHaveTextContent(
      "cliquez de nouveau sur « Lancer l'OCR » : les PDF en attente seront reconnus, sans qu'il faille cocher « Relancer l'OCR sur toutes les sources »"
    );
    expect(screen.queryByText(/voir la console/)).toBeNull();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('Windows : le téléchargement et le dossier « bin » à mettre dans le PATH', async () => {
    await runWith([{ code: 'poppler-missing' }], USER_AGENTS.windows);

    const notice = screen.getByText(/Poppler est introuvable/);
    expect(notice).toHaveTextContent('PATH');
    expect(notice).not.toHaveTextContent('brew');
  });

  it('Linux : le paquet poppler-utils', async () => {
    await runWith([{ code: 'poppler-missing' }], USER_AGENTS.linux);

    expect(screen.getByText(/Poppler est introuvable/)).toHaveTextContent('poppler-utils');
  });
});

describe('modale OCR : modèle de langue introuvable (L06-10, S08-1-29)', () => {
  it('la langue est nommée comme dans la liste, avec ce qu’il faut faire', async () => {
    await runWith([{ code: 'ocr-language-unavailable', language: 'frk' }]);

    const notice = screen.getByText(/« Allemand Fraktur »/);
    expect(notice).toHaveTextContent(/connexion à Internet/);
    expect(screen.queryByText(/voir la console/)).toBeNull();
    // La passe a rendu la main : le bouton est de nouveau libre.
    expect(screen.getByRole('button', { name: /Lancer l'OCR/ })).not.toBeDisabled();
  });
});

// Revue de L06-10 : « Aucune transcription nouvelle. Les sources concernées en
// avaient déjà une, ou la reconnaissance n'a rien produit d'exploitable. »
// s'affichait au-dessus de l'avis, alors que la reconnaissance n'avait pas
// tourné : deux explications fausses.
describe('modale OCR : la reconnaissance n’a pas pu se faire', () => {
  it.each([
    ['modèle de langue introuvable', { code: 'ocr-language-unavailable', language: 'frk' }],
    ['Poppler absent', { code: 'poppler-missing' }],
  ])('%s : l’avis seul, sans « Aucune transcription nouvelle »', async (_label, issue) => {
    await runWith([issue]);

    expect(screen.queryByText(/Aucune transcription nouvelle/)).toBeNull();
    expect(screen.getByText(/n'a pas pu démarrer|Poppler est introuvable/)).toBeInTheDocument();
  });

  it('une passe sans rien de neuf ni d’empêchement garde son explication', async () => {
    await runWith([]);

    expect(screen.getByText(/Aucune transcription nouvelle/)).toBeInTheDocument();
  });
});
