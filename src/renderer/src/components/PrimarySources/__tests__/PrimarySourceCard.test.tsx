// @vitest-environment jsdom
/**
 * Carte d'une source primaire : des pages changées dans Tropy (G3).
 *
 * Une page passée d'un item OCRisé à l'autre laisse son texte dans la
 * transcription de l'item qu'elle a quitté. La synchro marque les deux sources
 * (`ocrPending = 'pages'`) et la passe d'OCR suivante les reprend ; d'ici là,
 * la carte doit le dire. La marque n'arrivait pas jusqu'au renderer : la
 * lecture des sources la laissait en route. Vrais store et composant, vraies
 * chaînes françaises ; seul le pont `window.electron` est simulé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PrimarySourceCard } from '../PrimarySourceCard';
import { usePrimarySourcesStore, type PrimarySource } from '../../../stores/primarySourcesStore';

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
  transcription: 'Le préfet de la Loire-Inférieure au ministre de l’Intérieur.',
  transcriptionSource: 'tesseract',
  photoCount: 2,
  lastModified: '2026-11-01T00:00:00.000Z',
  indexedAt: '2026-11-01T00:00:00.000Z',
};

const PAGES_CHANGED = /Pages modifiées dans Tropy/;

let tropy: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  tropy = {
    getAllSources: vi.fn(async () => ({ success: true, sources: [] })),
  };
  (window as unknown as { electron: Record<string, unknown> }).electron.tropy = tropy;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePrimarySourcesStore.setState({ sources: [], filteredSources: [] });
});

describe('carte : pages changées dans Tropy (G3)', () => {
  it('marque « pages » : la carte dit que la transcription sera refaite au prochain « Lancer l’OCR »', () => {
    render(<PrimarySourceCard source={{ ...SOURCE, ocrPending: 'pages' }} />);

    const line = screen.getByText(PAGES_CHANGED);
    expect(line.textContent).toContain('« Lancer l\'OCR »');
  });

  it('sans marque : rien de plus sur la carte', () => {
    render(<PrimarySourceCard source={SOURCE} />);

    expect(screen.queryByText(PAGES_CHANGED)).toBeNull();
  });

  it('la marque lue dans le main arrive jusqu’à la carte', async () => {
    tropy.getAllSources.mockResolvedValue({ success: true, sources: [{ ...SOURCE, ocrPending: 'pages' }] });

    await usePrimarySourcesStore.getState().refreshSources();
    const [source] = usePrimarySourcesStore.getState().sources;
    render(<PrimarySourceCard source={source} />);

    expect(screen.getByText(PAGES_CHANGED)).toBeInTheDocument();
  });
});
