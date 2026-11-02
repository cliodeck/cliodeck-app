// @vitest-environment jsdom
/**
 * Régression : les trois modales d'export désactivaient Annuler et X pendant
 * l'export, mais Échap appelait directement `onClose`. La modale disparaissait,
 * l'issue de l'export n'avait plus d'interface, et la minuterie de succès,
 * jamais annulée, appelait plus tard le `onClose` du parent : celui d'ExportHub
 * ferme ce qui est ouvert à ce moment-là, y compris une autre modale d'export.
 */
import React, { useState } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  useEditorStore: () => ({
    content: 'Un texte',
    filePath: '/tmp/demo/document.md',
    getLiveContent: () => 'Un texte',
  }),
}));

import { PDFExportModal } from '../PDFExportModal';
import { WordExportModal } from '../WordExportModal';
import { PresentationExportModal } from '../PresentationExportModal';
import { useManuscriptStore } from '../../../stores/manuscriptStore';

interface ExportOutcome {
  success: boolean;
  error?: string;
}

type ExportModal = React.FC<{ isOpen: boolean; onClose: () => void }>;

const MODALS: Array<{ name: string; Modal: ExportModal; exportLabel: string; exportingLabel: string }> = [
  {
    name: 'PDF',
    Modal: PDFExportModal,
    exportLabel: 'export.pdf.export',
    exportingLabel: 'export.pdf.exporting',
  },
  {
    name: 'Word',
    Modal: WordExportModal,
    exportLabel: 'export.word.export',
    exportingLabel: 'export.word.exporting',
  },
  {
    name: 'présentation',
    Modal: PresentationExportModal,
    exportLabel: 'presentation.export',
    exportingLabel: 'presentation.exporting',
  },
];

/** Installe un `export` que le test termine quand il veut. */
function installElectron(): (outcome: ExportOutcome) => void {
  let release: (outcome: ExportOutcome) => void = () => undefined;
  const exportFn = () =>
    new Promise<ExportOutcome>((resolve) => {
      release = resolve;
    });
  (window as unknown as { electron: unknown }).electron = {
    pdfExport: {
      checkDependencies: vi.fn().mockResolvedValue({ pandoc: true, xelatex: true }),
      onProgress: () => () => undefined,
      export: exportFn,
    },
    wordExport: {
      findTemplate: vi.fn().mockResolvedValue({ success: false, templatePath: null }),
      onProgress: () => () => undefined,
      export: exportFn,
    },
    revealJsExport: {
      onProgress: () => () => undefined,
      export: exportFn,
    },
    dialog: { saveFile: vi.fn().mockResolvedValue({ canceled: true }) },
    fs: {
      readFile: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
    },
    citation: {
      listStyles: vi.fn().mockResolvedValue({ success: true, styles: [] }),
      listLocales: vi.fn().mockResolvedValue({ success: true, locales: [] }),
    },
    config: { get: vi.fn().mockResolvedValue(null) },
  };
  return (outcome) => release(outcome);
}

/** Comme ExportHub : `onClose` démonte la modale. */
function Host({ Modal, onClose }: { Modal: ExportModal; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <Modal
      isOpen
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  );
}

async function startExport(exportLabel: string, exportingLabel: string): Promise<void> {
  const button = await screen.findByRole('button', { name: exportLabel });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await screen.findByRole('button', { name: exportingLabel });
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  // Un test rouge laisse son export en suspens, et le verrou du manuscrit avec.
  useManuscriptStore.getState().setExporting(false);
});

describe.each(MODALS)('modale d’export $name', ({ Modal, exportLabel, exportingLabel }) => {
  it('Échap pendant l’export ne ferme pas : l’issue reste à l’écran', async () => {
    const finish = installElectron();
    const onClose = vi.fn();
    const { container } = render(<Host Modal={Modal} onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: exportingLabel })).toBeInTheDocument();

    finish({ success: false, error: 'xelatex a échoué' });
    await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());
    expect(container.querySelector('.export-error')).toHaveTextContent('xelatex a échoué');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Échap au repos ferme la modale', async () => {
    installElectron();
    const onClose = vi.fn();
    render(<Host Modal={Modal} onClose={onClose} />);
    await screen.findByRole('button', { name: exportLabel });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('démontée après un succès, sa minuterie n’appelle plus onClose', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    const onClose = vi.fn();
    const { container, unmount } = render(<Modal isOpen onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    finish({ success: true });
    await waitFor(() => expect(container.querySelector('.export-success')).not.toBeNull());
    unmount();
    vi.advanceTimersByTime(10_000);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('restée ouverte après un succès, elle se ferme d’elle-même', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    const onClose = vi.fn();
    const { container } = render(<Modal isOpen onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    finish({ success: true });
    await waitFor(() => expect(container.querySelector('.export-success')).not.toBeNull());
    vi.advanceTimersByTime(2_000);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
