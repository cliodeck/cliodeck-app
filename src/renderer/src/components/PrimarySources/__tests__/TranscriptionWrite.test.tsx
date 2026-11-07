// @vitest-environment jsdom
/**
 * Écrire une transcription depuis la carte (OCR manuel), la modale d'import ou
 * la modale OCR : l'historien apprend ce qui est devenu de son texte (L06-7).
 *
 * Écrite mais pas indexée — Ollama arrêté, aucun modèle —, la transcription
 * était annoncée « importée » ou rien n'était dit, alors que l'assistant ne la
 * citait plus. Écriture refusée par le main, l'import disait quand même
 * « Transcription importée. » (S15-1-8). Vrais store et composants, vraies
 * chaînes françaises ; seul le pont `window.electron` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PrimarySourceCard } from '../PrimarySourceCard';
import { TranscriptionImportModal } from '../TranscriptionImportModal';
import { OCRSettingsModal } from '../OCRSettingsModal';
import { usePrimarySourcesStore, type PrimarySource } from '../../../stores/primarySourcesStore';
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

const SOURCE: PrimarySource = {
  id: 'src-a',
  tropyId: 10,
  title: 'Rapport du préfet',
  tags: [],
  photoCount: 1,
  lastModified: '2026-11-01T00:00:00.000Z',
  indexedAt: '2026-11-01T00:00:00.000Z',
};

const NOT_INDEXED = /Transcription enregistrée, pas encore indexée/;

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    getSourcePhotos: vi.fn(async () => ({ success: true, paths: ['/archives/p1.jpg'] })),
    performBatchOCR: vi.fn(async () => ({ success: true, text: 'Texte reconnu', confidence: 81 })),
    importTranscription: vi.fn(async () => ({ success: true, text: 'Texte importé', format: 'plain-text' })),
    updateTranscription: vi.fn(async () => ({
      success: true,
      reindexError: 'connect ECONNREFUSED 127.0.0.1:11434',
      reindexCode: 'embedding-failed',
    })),
    getAllSources: vi.fn(async () => ({ success: true, sources: [SOURCE] })),
    getStatistics: vi.fn(async () => ({ success: true, statistics: null })),
    getProjectInfo: vi.fn(async () => ({ success: true, info: null })),
    getOCRLanguages: vi.fn(async () => ({ success: true, languages: [{ code: 'fra', name: 'Français' }] })),
    onSyncProgress: vi.fn(() => () => undefined),
    sync: vi.fn(async () => ({ success: true, errors: [], issues: [] })),
  };
  const electron = (window as unknown as { electron: Record<string, unknown> }).electron;
  electron.tropy = tropy;
  electron.dialog = { openFile: async () => ({ canceled: false, filePaths: ['/transcriptions/p1.txt'] }) };
  usePrimarySourcesStore.setState({ selectedSourceId: 'src-a', isPerformingOCR: false, isSyncing: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePrimarySourcesStore.setState({ selectedSourceId: null, syncIssues: [] });
});

describe('carte : OCR manuel', () => {
  it('écrit mais pas indexé : la carte dit « enregistrée, pas encore indexée »', async () => {
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourceCard source={SOURCE} />);

    fireEvent.click(screen.getByTitle('Lancer l’OCR sur cette source'.replace('’', "'")));

    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));
    expect(showAlert.mock.calls[0][0]).toMatch(NOT_INDEXED);
    // La piste vaut pour tout fournisseur : modèle embarqué (le seul sous
    // macOS 13, sans Ollama), cloud ou Ollama.
    expect(showAlert.mock.calls[0][0]).toMatch(/vérifiez dans les Paramètres qu'il est disponible/);
    expect(showAlert.mock.calls[0][0]).not.toMatch(/Ollama/);
  });

  it('écriture refusée : « n’a pas été enregistrée », pas « l’OCR a échoué »', async () => {
    tropy.updateTranscription.mockResolvedValue({ success: false, error: 'SQLITE_BUSY' });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourceCard source={SOURCE} />);

    fireEvent.click(screen.getByTitle("Lancer l'OCR sur cette source"));

    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));
    expect(showAlert.mock.calls[0][0]).toBe('La transcription n’a pas été enregistrée.'.replace('’', "'"));
  });

  it('écrite et indexée : la carte ne dérange pas', async () => {
    tropy.updateTranscription.mockResolvedValue({ success: true });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<PrimarySourceCard source={SOURCE} />);

    fireEvent.click(screen.getByTitle("Lancer l'OCR sur cette source"));

    await waitFor(() => expect(tropy.updateTranscription).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTitle("Lancer l'OCR sur cette source")).not.toBeDisabled());
    expect(showAlert).not.toHaveBeenCalled();
  });
});

describe('modale : import d’un fichier pour la source sélectionnée', () => {
  async function importOne(): Promise<void> {
    render(<TranscriptionImportModal isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Importer' }));
  }

  it('écrit mais pas indexé : le message le dit, et pas « Transcription importée. »', async () => {
    await importOne();

    expect(await screen.findByText(NOT_INDEXED)).toBeInTheDocument();
    expect(screen.queryByText('Transcription importée.')).toBeNull();
  });

  it('la source n’est plus en base : rien d’écrit, et le message dit pourquoi', async () => {
    tropy.updateTranscription.mockResolvedValue({
      success: false,
      error: 'Source not found: src-a',
      code: 'source-not-found',
    });
    await importOne();

    expect(await screen.findByText(/cette source n'est plus dans la base du projet/)).toBeInTheDocument();
    expect(screen.queryByText('Transcription importée.')).toBeNull();
  });

  it('écrite et indexée : « Transcription importée. »', async () => {
    tropy.updateTranscription.mockResolvedValue({ success: true });
    await importOne();

    expect(await screen.findByText('Transcription importée.')).toBeInTheDocument();
  });
});

describe('modale OCR : bilan de la passe', () => {
  it('des sources pas encore indexées : le bilan le dit, sans alerte', async () => {
    tropy.sync.mockResolvedValue({
      success: true,
      transcriptionsWritten: 2,
      ocrPerformed: 2,
      errors: [],
      issues: [{ code: 'embedding-failed', sources: 2 }],
    });
    const showAlert = vi.spyOn(useDialogStore.getState(), 'showAlert').mockResolvedValue(undefined);
    render(<OCRSettingsModal isOpen onClose={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /Lancer l'OCR/ }));

    expect(
      await screen.findByText(/2 source\(s\) enregistrée\(s\), pas encore indexée\(s\)/)
    ).toBeInTheDocument();
    expect(showAlert).not.toHaveBeenCalled();
  });
});
