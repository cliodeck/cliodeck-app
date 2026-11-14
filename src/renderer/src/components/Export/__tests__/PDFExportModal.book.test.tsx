// @vitest-environment jsdom
/**
 * Revue de L04-4 (L09-12) : la fenêtre PDF écartait d'elle-même les chapitres manquants avant
 * d'appeler le main. L'assembleur ne les voyait jamais, et ne pouvait pas dire qu'il les omettait :
 * le Word prévenait (sa fenêtre transmet tout le manifeste), le PDF sortait sans le chapitre, sans
 * un mot. Elle transmet désormais le manifeste entier ; l'avertissement vient du main
 * (`pdf-export-warnings.test.ts`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const book = vi.hoisted(() => {
  const project = {
    currentProject: {
      name: 'livre',
      path: '/tmp/livre',
      type: 'book',
      bibliography: '',
      cslPath: '',
    },
    chapters: [
      { id: 'a', title: 'Ouverture', filePath: 'chapters/01.md', order: 0 },
      { id: 'b', title: 'Disparu', filePath: 'chapters/02.md', order: 1, missing: true },
      { id: 'c', title: 'Dehors', filePath: 'chapters/03.md', order: 2, missing: true, outsideProject: true },
    ],
    bookSettings: {},
  };
  const editor = {
    content: '# Ouverture\n',
    filePath: '/tmp/livre/chapters/01.md',
    getLiveContent: () => '# Ouverture\n',
  };
  return { project, editor };
});

vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: Object.assign(() => book.project, { getState: () => book.project }),
}));
vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: Object.assign(() => book.editor, { getState: () => book.editor }),
}));

import { PDFExportModal } from '../PDFExportModal';

afterEach(() => cleanup());

describe('fenêtre PDF d’un livre : les chapitres manquants', () => {
  it('partent au main avec le manifeste, qui saura dire qu’il les omet', async () => {
    const exportSpy = vi.fn().mockResolvedValue({ success: true });
    (window as unknown as { electron: unknown }).electron = {
      pdfExport: {
        checkDependencies: vi.fn().mockResolvedValue({ pandoc: true, xelatex: true }),
        onProgress: () => () => undefined,
        export: exportSpy,
      },
      dialog: { saveFile: vi.fn().mockResolvedValue({ canceled: true }) },
      fs: { readFile: vi.fn(), exists: vi.fn().mockResolvedValue(false) },
      citation: {
        listStyles: vi.fn().mockResolvedValue({ success: true, styles: [] }),
        listLocales: vi.fn().mockResolvedValue({ success: true, locales: [] }),
      },
      config: { get: vi.fn().mockResolvedValue(null) },
    };
    render(<PDFExportModal isOpen onClose={() => undefined} />);

    const exportButton = await screen.findByRole('button', { name: 'export.pdf.export' });
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.click(exportButton);

    await waitFor(() => expect(exportSpy).toHaveBeenCalledTimes(1));
    const payload = exportSpy.mock.calls[0][0] as { manuscript?: { chapters: Array<{ filePath: string }> } };
    expect(payload.manuscript?.chapters.map((c) => c.filePath)).toEqual([
      'chapters/01.md',
      'chapters/02.md',
      'chapters/03.md',
    ]);
  });
});
