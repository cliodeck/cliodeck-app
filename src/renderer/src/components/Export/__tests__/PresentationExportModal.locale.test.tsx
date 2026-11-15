// @vitest-environment jsdom
/**
 * Export de présentation, dans les mots de l'interface (fr réel, pas les clés).
 *
 * - Un article exporte document.md en diaporama (Q43) : c'est son frontmatter que lit le main
 *   (`resolveDeckConfig`), et la phrase qui dit qu'il prime sur reveal-config.json nommait
 *   pourtant slides.md en dur. Un livre ne s'exporte pas en présentation : la phrase n'a pas
 *   de fichier à nommer.
 * - Le main refuse d'écrire l'export dans un fichier Markdown (`export-output-path.ts`) : la
 *   fenêtre le dit par sa phrase, avec le nom du fichier.
 * - Les touches de reveal.js : la lettre, puis ce qu'elle fait. Un `.replace` ne retirait que le
 *   préfixe anglais de la traduction, d'où « S : Touche S : … » en français et « S : S-Taste: … »
 *   en allemand (S12-2-7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_BOOK_SETTINGS } from '@backend/types/book';
import fr from '../../../../../../public/locales/fr/common.json';
import en from '../../../../../../public/locales/en/common.json';
import de from '../../../../../../public/locales/de/common.json';

/** La langue des rendus : fr, sauf dans les tests qui la changent. */
const ui = vi.hoisted(() => ({ lng: 'fr' as 'fr' | 'en' | 'de' }));

vi.mock('react-i18next', async () => {
  const i18next = (await import('i18next')).default;
  const [frCommon, enCommon, deCommon] = await Promise.all([
    import('../../../../../../public/locales/fr/common.json'),
    import('../../../../../../public/locales/en/common.json'),
    import('../../../../../../public/locales/de/common.json'),
  ]);
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'fr',
    ns: ['common'],
    defaultNS: 'common',
    resources: {
      fr: { common: frCommon.default },
      en: { common: enCommon.default },
      de: { common: deCommon.default },
    },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  return {
    useTranslation: () => ({ t: instance.getFixedT(ui.lng), i18n: instance }),
    Trans: ({ children }: { children?: unknown }) => children ?? null,
    initReactI18next: { type: '3rdParty', init: () => undefined },
  };
});

import { PresentationExportModal } from '../PresentationExportModal';
import { useEditorStore } from '../../../stores/editorStore';
import { useProjectStore } from '../../../stores/projectStore';

const PROJECT = "/p/Séminaire d'histoire";

function openProject(type: 'article' | 'presentation' | 'book'): void {
  useProjectStore.setState({
    currentProject: {
      id: 'p1',
      name: "Séminaire d'histoire",
      path: PROJECT,
      type,
      createdAt: new Date(),
      lastOpenedAt: new Date(),
    },
    chapters: [],
    bookSettings: { ...DEFAULT_BOOK_SETTINGS },
  } as never);
}

const exportCall = vi.fn();

beforeEach(() => {
  exportCall.mockReset();
  (window as unknown as { electron: unknown }).electron = {
    fs: {
      exists: vi.fn(async () => false),
      readFile: vi.fn(async (path: string) => {
        if (path === `${PROJECT}/slides.md`) return '# Une diapositive\n';
        throw new Error(`ENOENT: ${path}`);
      }),
    },
    revealJsExport: {
      onProgress: () => () => undefined,
      export: exportCall,
      exportOffline: exportCall,
      exportPDF: exportCall,
    },
    dialog: { saveFile: vi.fn(async () => ({ canceled: true })) },
  };
  useEditorStore.setState({ filePath: null, editorFacade: null } as never);
});

afterEach(() => {
  cleanup();
  ui.lng = 'fr';
  useProjectStore.setState({ currentProject: null, chapters: [] } as never);
});

describe('la phrase sur le frontmatter nomme le fichier exporté', () => {
  it('un article : document.md, pas slides.md', () => {
    openProject('article');
    render(<PresentationExportModal isOpen onClose={() => undefined} />);

    expect(screen.getByText(/Le frontmatter YAML de document\.md \(title/)).toBeInTheDocument();
    expect(screen.queryByText(/slides\.md/)).toBeNull();
  });

  it('une présentation : slides.md', () => {
    openProject('presentation');
    render(<PresentationExportModal isOpen onClose={() => undefined} />);

    expect(screen.getByText(/Le frontmatter YAML de slides\.md \(title/)).toBeInTheDocument();
  });

  it('un livre : aucune phrase, il n’a pas de fichier à exporter en présentation', () => {
    openProject('book');
    render(<PresentationExportModal isOpen onClose={() => undefined} />);

    expect(screen.queryByText(/frontmatter YAML/)).toBeNull();
  });

  it.each([
    ['fr', fr],
    ['en', en],
    ['de', de],
  ])('%s : le nom du fichier est un paramètre, pas « slides.md » écrit en dur', (_lang, locale) => {
    const text = (locale as { presentation: { frontmatterPrecedence: string } }).presentation.frontmatterPrecedence;
    expect(text).toContain('{{file}}');
    expect(text).not.toContain('slides.md');
  });
});

describe('les touches de reveal.js : la lettre, puis ce qu’elle fait, une seule fois', () => {
  it.each([
    ['fr', ['S : Mode présentateur avec notes', 'F : Plein écran', "ESC : Vue d'ensemble"]],
    ['de', ['S : Präsentationsmodus mit Notizen', 'F : Vollbild', 'ESC : Übersicht']],
    ['en', ['S : Presenter mode with notes', 'F : Fullscreen', 'ESC : Overview']],
  ] as const)('%s', (lng, expected) => {
    ui.lng = lng;
    openProject('presentation');
    render(<PresentationExportModal isOpen onClose={() => undefined} />);

    const keyLines = screen
      .getAllByRole('listitem')
      .filter((item) => item.querySelector('code') !== null)
      .map((item) => item.textContent);
    expect(keyLines).toEqual(expected);
  });
});

it('le main refuse un fichier de sortie Markdown : la fenêtre le dit, avec le nom du fichier', async () => {
  openProject('presentation');
  exportCall.mockResolvedValueOnce({
    success: false,
    error: `Le fichier de sortie ${PROJECT}/slides.md est un fichier Markdown : l'export ne le remplace pas.`,
    errorCode: 'export.outputIsMarkdown',
    errorParams: { file: 'slides.md' },
  });
  render(<PresentationExportModal isOpen onClose={() => undefined} />);
  const field = screen.getByPlaceholderText('/chemin/vers/fichier.html');
  fireEvent.change(field, { target: { value: 'slides.md' } });

  fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));

  expect(
    await screen.findByText(/« slides\.md » est un fichier Markdown : l'export ne l'écrit pas/)
  ).toBeInTheDocument();
  expect(exportCall).toHaveBeenCalledTimes(1);
  expect(field).toHaveValue('slides.md');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Exporter' })).not.toBeDisabled());
});
