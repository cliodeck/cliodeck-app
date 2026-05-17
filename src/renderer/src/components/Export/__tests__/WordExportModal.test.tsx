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
vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: () => ({ content: 'Some body [@smith2020]' }),
}));

import { WordExportModal } from '../WordExportModal';

interface ExportOpts {
  citation?: { useEngine: boolean; style: string; locale: string };
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
    expect(screen.queryByLabelText('Citation style')).not.toBeInTheDocument();

    // Turn on; dropdowns appear.
    fireEvent.click(toggle);
    expect(await screen.findByLabelText('Citation style')).toBeInTheDocument();
    expect(screen.getByLabelText('Citation locale')).toBeInTheDocument();
  });

  it('sends citation option in word-export payload when enabled', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<WordExportModal isOpen onClose={() => undefined} />);

    const toggle = (await screen.findByTestId('export-citation-toggle')) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));

    const exportBtn = await screen.findByRole('button', { name: /Exporter/ });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const payload = exportSpy.mock.calls[0][0] as ExportOpts;
    expect(payload.citation?.useEngine).toBe(true);
    expect(payload.citation?.style).toBeTruthy();
    expect(payload.citation?.locale).toBeTruthy();
  });
});
