// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: {
      name: 'demo',
      path: '/tmp/demo',
      type: 'article',
      bibliography: '/tmp/demo/biblio.bib',
      cslPath: '',
    },
  }),
}));
// Le manuscrit de l'article est le fichier ouvert : l'export doit alors
// prendre le texte VIVANT de l'éditeur, pas relire le disque.
vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: () => ({
    content: 'Some body [@smith2020]',
    filePath: '/tmp/demo/document.md',
    getLiveContent: () => 'Some body [@smith2020]',
  }),
}));

import { WordExportModal } from '../WordExportModal';

interface ExportOpts {
  citation?: { useEngine: boolean; style: string; locale: string };
  metadata?: Record<string, unknown>;
}

function installElectron(exportSpy: ReturnType<typeof vi.fn>): void {
  (window as unknown as { electron: unknown }).electron = {
    wordExport: {
      onProgress: () => () => undefined,
      findTemplate: vi.fn().mockResolvedValue({ success: false, templatePath: null }),
      export: exportSpy,
    },
    dialog: {
      saveFile: vi.fn().mockResolvedValue({ canceled: true }),
    },
    fs: {
      readFile: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
    },
    citation: {
      listStyles: vi.fn().mockResolvedValue({
        success: true,
        styles: [
          { id: 'chicago-note-bibliography', label: 'Chicago' },
          { id: 'modern-language-association', label: 'MLA' },
        ],
      }),
      listLocales: vi.fn().mockResolvedValue({ success: true, locales: ['fr-FR', 'en-US'] }),
    },
    config: {
      // No persisted style → toggle off by default.
      get: vi.fn().mockResolvedValue(null),
    },
  };
}

describe('WordExportModal citation section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('renders section and toggles dropdowns on/off', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<WordExportModal isOpen onClose={() => undefined} />);

    expect(await screen.findByTestId('export-citation-section')).toBeInTheDocument();

    const toggle = screen.getByTestId('export-citation-toggle') as HTMLInputElement;
    // No config → off; dropdowns absent.
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(screen.queryByLabelText('export.citation.styleAria')).not.toBeInTheDocument();

    // Turn on; dropdowns appear.
    fireEvent.click(toggle);
    expect(await screen.findByLabelText('export.citation.styleAria')).toBeInTheDocument();
    expect(screen.getByLabelText('export.citation.localeAria')).toBeInTheDocument();
  });

  it('sends citation option in word-export payload when enabled', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<WordExportModal isOpen onClose={() => undefined} />);

    const toggle = (await screen.findByTestId('export-citation-toggle')) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));

    const exportBtn = await screen.findByRole('button', { name: /export\.(pdf|word)\.export/ });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const payload = exportSpy.mock.calls[0][0] as ExportOpts;
    expect(payload.citation?.useEngine).toBe(true);
    expect(payload.citation?.style).toBeTruthy();
    expect(payload.citation?.locale).toBeTruthy();
  });
});

/**
 * S18-1-3 : le champ Auteur laissé vide envoyait « ClioDesk », et la fenêtre imposait la date du
 * jour au format français. En `-M`, l'un et l'autre écrasaient le front matter du document. La
 * fenêtre n'envoie plus que ce que l'auteur a saisi : le main propose la date du jour, que le
 * `date` du front matter remplace (Q42).
 */
describe('WordExportModal : métadonnées', () => {
  afterEach(() => cleanup());

  async function exportPayload(author?: string): Promise<ExportOpts> {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<WordExportModal isOpen onClose={() => undefined} />);
    if (author !== undefined) {
      fireEvent.change(screen.getByLabelText('export.word.author'), { target: { value: author } });
    }
    const exportBtn = await screen.findByRole('button', { name: 'export.word.export' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    return exportSpy.mock.calls[0][0] as ExportOpts;
  }

  it('champ Auteur vide : ni auteur ni date, jamais « ClioDesk »', async () => {
    const payload = await exportPayload();
    expect(payload.metadata).toEqual({ title: 'demo', author: undefined });
    expect(payload.metadata).not.toHaveProperty('date');
    expect(JSON.stringify(payload)).not.toMatch(/ClioDes[kc]/);
  });

  it('auteur saisi : il part tel quel', async () => {
    const payload = await exportPayload('Frédéric Clavert');
    expect(payload.metadata?.author).toBe('Frédéric Clavert');
  });
});
