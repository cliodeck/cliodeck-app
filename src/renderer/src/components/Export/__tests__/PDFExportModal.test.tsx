// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// Stores used by the modal.
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

import { PDFExportModal } from '../PDFExportModal';

interface ExportOpts {
  citation?: { useEngine: boolean; style: string; locale: string };
}

function installElectron(exportSpy: ReturnType<typeof vi.fn>): void {
  (window as unknown as { electron: unknown }).electron = {
    pdfExport: {
      checkDependencies: vi.fn().mockResolvedValue({ pandoc: true, xelatex: true }),
      onProgress: () => () => undefined,
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
      get: vi.fn().mockResolvedValue({ style: 'chicago-note-bibliography', locale: 'fr-FR' }),
    },
  };
}

describe('PDFExportModal citation section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('renders citation toggle and hides dropdowns when off', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<PDFExportModal isOpen onClose={() => undefined} />);

    // Section is present.
    expect(await screen.findByTestId('export-citation-section')).toBeInTheDocument();

    // Toggle is on by default (config has a style).
    const toggle = screen.getByTestId('export-citation-toggle') as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));

    // Dropdowns present while on.
    expect(screen.getByLabelText('Citation style')).toBeInTheDocument();
    expect(screen.getByLabelText('Citation locale')).toBeInTheDocument();

    // Turn off; dropdowns go away.
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.queryByLabelText('Citation style')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Citation locale')).not.toBeInTheDocument();
    });
  });

  it('includes citation option in export payload when engine is enabled', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    installElectron(exportSpy);
    render(<PDFExportModal isOpen onClose={() => undefined} />);

    const toggle = (await screen.findByTestId('export-citation-toggle')) as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));

    // Click the export button (wait for deps check to enable it).
    const exportBtn = await screen.findByRole('button', { name: /Exporter/ });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const payload = exportSpy.mock.calls[0][0] as ExportOpts;
    expect(payload.citation).toEqual({
      useEngine: true,
      style: 'chicago-note-bibliography',
      locale: 'fr-FR',
    });
  });
});
