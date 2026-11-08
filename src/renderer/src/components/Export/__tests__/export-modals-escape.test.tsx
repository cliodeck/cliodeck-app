// @vitest-environment jsdom
/**
 * Régression : les trois modales d'export désactivaient Annuler et X pendant
 * l'export, mais Échap appelait directement `onClose`. La modale disparaissait,
 * l'issue de l'export n'avait plus d'interface, et la minuterie de succès,
 * jamais annulée, appelait plus tard le `onClose` du parent : celui d'ExportHub
 * ferme ce qui est ouvert à ce moment-là, y compris une autre modale d'export.
 */
import React, { useState } from 'react';
import { describe, expect, it, vi, afterEach, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EXPORT_TIME_LIMIT_MS } from '@backend/types/export-limits';

/** Ce que chaque test fait varier : le type du projet et le fichier ouvert. */
const opened = vi.hoisted(() => ({ type: 'article', file: '/tmp/demo/document.md' }));

vi.mock('../../../stores/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: {
      name: 'demo',
      path: '/tmp/demo',
      type: opened.type,
      bibliography: '/tmp/demo/biblio.bib',
      cslPath: '',
    },
  }),
}));
vi.mock('../../../stores/editorStore', () => ({
  useEditorStore: () => ({
    content: 'Un texte',
    filePath: opened.file,
    getLiveContent: () => 'Un texte',
  }),
}));

// MainLayout, pour le changement de panneau par le menu : seuls ses panneaux
// lourds sont remplacés, le panneau gauche et son aiguillage restent les vrais.
vi.mock('../../Bibliography/BibliographyPanel', () => ({
  BibliographyPanel: () => <div data-testid="panneau-bibliographie" />,
}));
vi.mock('../../Chat/AssistantChat', () => ({ AssistantChat: () => null }));
vi.mock('../../Project/ProjectPanel', () => ({ ProjectPanel: () => null }));
vi.mock('../../Brainstorm/BrainstormPanel', () => ({ BrainstormPanel: () => null }));
vi.mock('../../Layout/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../common/StatusToast', () => ({ StatusToast: () => null }));

import { PDFExportModal } from '../PDFExportModal';
import { WordExportModal } from '../WordExportModal';
import { PresentationExportModal } from '../PresentationExportModal';
import { MainLayout } from '../../Layout/MainLayout';
import { OnboardingWizard } from '../../Project/OnboardingWizard';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useManuscriptStore } from '../../../stores/manuscriptStore';

interface ExportOutcome {
  success: boolean;
  error?: string;
  errorCode?: string;
  timeLimitMinutes?: number;
  unresolvedCitations?: string[];
  missingCsl?: string;
  unusableCsl?: { path: string; reason: 'dependent' | 'unreadable' };
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

let exportCall: Mock;

/** Installe un `export` que le test termine quand il veut. */
function installElectron(): (outcome: ExportOutcome) => void {
  let release: (outcome: ExportOutcome) => void = () => undefined;
  const exportFn = vi.fn(
    (_options: unknown) =>
      new Promise<ExportOutcome>((resolve) => {
        release = resolve;
      })
  );
  exportCall = exportFn;
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

const electronFs = () =>
  (window as unknown as { electron: { fs: Record<string, unknown> } }).electron.fs;

/**
 * Un disque qui ne répond plus : ni `exists` ni `readFile` ne rendent la main, tant
 * que le test ne le décide pas.
 */
function stickDisk(content = '{}'): { unstick: () => void } {
  let stuck = true;
  const waiting: Array<() => void> = [];
  function read<T>(answer: T) {
    return () =>
      stuck
        ? new Promise<T>((resolve) => waiting.push(() => resolve(answer)))
        : Promise.resolve(answer);
  }
  const fs = electronFs();
  fs.exists = read(true);
  fs.readFile = read(content);
  return {
    unstick: () => {
      stuck = false;
      for (const release of waiting) release();
    },
  };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  // Un test rouge laisse son export en suspens, et le verrou du manuscrit avec.
  useManuscriptStore.getState().setExporting(false);
  opened.type = 'article';
  opened.file = '/tmp/demo/document.md';
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

  it('démontée en plein export, sa minuterie n’est jamais armée', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    const onClose = vi.fn();
    const { unmount } = render(<Modal isOpen onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    unmount();
    await act(async () => {
      finish({ success: true });
      await vi.advanceTimersByTimeAsync(10_000);
    });

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

/**
 * Échap ne sort plus d'un export en cours : c'est la limite de durée du main qui
 * rend la main. La modale doit alors redevenir pleinement utilisable.
 */
describe.each(MODALS)('modale d’export $name : export arrêté par la limite', ({ Modal, exportLabel, exportingLabel }) => {
  const TIMED_OUT: ExportOutcome = {
    success: false,
    error: 'Export arrêté : aucun résultat après 15 minutes.',
    errorCode: 'export_timed_out',
    timeLimitMinutes: 15,
  };

  it('affiche le message traduit, réactive les boutons et relâche le drapeau', async () => {
    const finish = installElectron();
    const onClose = vi.fn();
    const { container } = render(<Host Modal={Modal} onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    finish(TIMED_OUT);

    await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());
    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');
    expect(screen.getByRole('button', { name: exportLabel })).not.toBeDisabled();
    expect(container.querySelector('.close-btn')).not.toBeDisabled();
    expect(useManuscriptStore.getState().exporting).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Échap referme ensuite la modale', async () => {
    const finish = installElectron();
    const onClose = vi.fn();
    const { container } = render(<Host Modal={Modal} onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);
    finish(TIMED_OUT);
    await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('un second export peut partir et efface le message', async () => {
    const finish = installElectron();
    const { container } = render(<Host Modal={Modal} onClose={vi.fn()} />);
    await startExport(exportLabel, exportingLabel);
    finish(TIMED_OUT);
    await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());

    await startExport(exportLabel, exportingLabel);
    expect(container.querySelector('.export-error')).toBeNull();

    finish({ success: true });
    await waitFor(() => expect(container.querySelector('.export-success')).not.toBeNull());
  });

  it('une autre erreur garde son affichage', async () => {
    const finish = installElectron();
    const { container } = render(<Host Modal={Modal} onClose={vi.fn()} />);
    await startExport(exportLabel, exportingLabel);

    finish({ success: false, error: 'xelatex a échoué' });

    await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());
    expect(container.querySelector('.export-error')).toHaveTextContent('xelatex a échoué');
  });
});

/**
 * Les modales lisent le disque avant d'appeler le main : le manuscrit quand c'est
 * un autre fichier qui est ouvert, les réglages reveal.js ou Beamer. L'horloge du
 * main n'a pas encore démarré, et Échap ne fait rien pendant un export : sur un
 * disque qui ne répond plus, il ne restait qu'à quitter l'app.
 */
describe.each(MODALS)('modale d’export $name : une lecture qui pend avant l’appel au main', ({ Modal, exportLabel, exportingLabel }) => {
  it('rend la main à l’échéance, sans avoir rien lancé', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installElectron();
    stickDisk();
    opened.file = '/tmp/demo/abstract.md';
    const onClose = vi.fn();
    const { container } = render(<Host Modal={Modal} onClose={onClose} />);
    await startExport(exportLabel, exportingLabel);

    await advance(EXPORT_TIME_LIMIT_MS - 60_000);
    expect(screen.getByRole('button', { name: exportingLabel })).toBeInTheDocument();
    expect(container.querySelector('.export-error')).toBeNull();

    await advance(60_000);

    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');
    expect(screen.getByRole('button', { name: exportLabel })).not.toBeDisabled();
    expect(container.querySelector('.close-btn')).not.toBeDisabled();
    expect(useManuscriptStore.getState().exporting).toBe(false);
    expect(exportCall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('une lecture qui se débloque après l’annonce ne lance plus l’export', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installElectron();
    const disk = stickDisk();
    opened.file = '/tmp/demo/abstract.md';
    const { container } = render(<Host Modal={Modal} onClose={vi.fn()} />);
    await startExport(exportLabel, exportingLabel);
    await advance(EXPORT_TIME_LIMIT_MS);
    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');

    disk.unstick();
    await advance(1000);

    expect(exportCall).not.toHaveBeenCalled();
    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');
  });

  it('une fois le disque revenu, un second export part', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    const disk = stickDisk();
    opened.file = '/tmp/demo/abstract.md';
    const { container } = render(<Host Modal={Modal} onClose={vi.fn()} />);
    await startExport(exportLabel, exportingLabel);
    await advance(EXPORT_TIME_LIMIT_MS);
    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');

    disk.unstick();
    await startExport(exportLabel, exportingLabel);
    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(container.querySelector('.export-error')).toBeNull();

    finish({ success: true });
    await waitFor(() => expect(container.querySelector('.export-success')).not.toBeNull());
  });

  it('la limite des lectures ne court plus pendant l’export lui-même, qui a la sienne', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    opened.file = '/tmp/demo/abstract.md';
    const { container } = render(<Host Modal={Modal} onClose={vi.fn()} />);
    await startExport(exportLabel, exportingLabel);
    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));

    await advance(EXPORT_TIME_LIMIT_MS);

    expect(container.querySelector('.export-error')).toBeNull();
    expect(screen.getByRole('button', { name: exportingLabel })).toBeInTheDocument();
    finish({ success: false, error: 'xelatex a échoué' });
    await waitFor(() => expect(container.querySelector('.export-error')).toHaveTextContent('xelatex a échoué'));
  });
});

describe('modale PDF d’une présentation : la lecture de beamer-config.json', () => {
  it('qui pend rend la main, le repli sur les valeurs par défaut ne l’avale pas', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installElectron();
    stickDisk();
    opened.type = 'presentation';
    opened.file = '/tmp/demo/slides.md';
    const { container } = render(<Host Modal={PDFExportModal} onClose={vi.fn()} />);
    await startExport('export.pdf.export', 'export.pdf.exporting');

    await advance(EXPORT_TIME_LIMIT_MS);

    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');
    expect(exportCall).not.toHaveBeenCalled();
  });

  it('partage la limite du manuscrit lu juste avant : une seule horloge', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installElectron();
    const fs = electronFs();
    let manuscript: (text: string) => void = () => undefined;
    fs.readFile = () => new Promise<string>((resolve) => { manuscript = resolve; });
    opened.type = 'presentation';
    opened.file = '/tmp/demo/abstract.md';
    const { container } = render(<Host Modal={PDFExportModal} onClose={vi.fn()} />);
    await startExport('export.pdf.export', 'export.pdf.exporting');

    // Le manuscrit arrive tard ; c'est ensuite la lecture de la configuration qui pend.
    await advance(EXPORT_TIME_LIMIT_MS - 60_000);
    stickDisk();
    manuscript('# Des diapositives');
    await advance(60_000);

    expect(container.querySelector('.export-error')).toHaveTextContent('export.timedOut');
    expect(exportCall).not.toHaveBeenCalled();
  });
});

describe('une configuration d’export illisible', () => {
  const unreadable = () => {
    const fs = electronFs();
    fs.exists = vi.fn().mockResolvedValue(true);
    fs.readFile = vi.fn().mockResolvedValue('{pas du json');
  };

  it('laisse partir l’export de présentation avec les valeurs par défaut', async () => {
    installElectron();
    unreadable();
    render(<Host Modal={PresentationExportModal} onClose={vi.fn()} />);
    await startExport('presentation.export', 'presentation.exporting');

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(exportCall.mock.calls[0][0]).toMatchObject({ config: {} });
  });

  it('laisse partir l’export PDF d’une présentation sans configuration Beamer', async () => {
    installElectron();
    unreadable();
    opened.type = 'presentation';
    opened.file = '/tmp/demo/slides.md';
    render(<Host Modal={PDFExportModal} onClose={vi.fn()} />);
    await startExport('export.pdf.export', 'export.pdf.exporting');

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(exportCall.mock.calls[0][0]).toMatchObject({ beamerConfig: undefined });
  });

  it('une configuration lisible arrive jusqu’à l’export', async () => {
    installElectron();
    const fs = electronFs();
    fs.exists = vi.fn().mockResolvedValue(true);
    fs.readFile = vi.fn().mockResolvedValue('{"theme":"black"}');
    render(<Host Modal={PresentationExportModal} onClose={vi.fn()} />);
    await startExport('presentation.export', 'presentation.exporting');

    await waitFor(() => expect(exportCall).toHaveBeenCalledTimes(1));
    expect(exportCall.mock.calls[0][0]).toMatchObject({ config: { theme: 'black' } });
  });
});

/**
 * ProjectPanel monte les modales PDF et Word dans le panneau gauche. Le fond de
 * la modale bloque la souris, mais pas les accélérateurs de menu : Alt+2 quittait
 * le panneau, donc démontait la modale, et l'issue de l'export n'était vue nulle
 * part (en souffrait surtout un échec, ou les citations non résolues d'un Word).
 */
describe.each(MODALS.filter(({ name }) => name !== 'présentation'))(
  'modale d’export $name dans le panneau gauche',
  ({ Modal, exportLabel, exportingLabel }) => {
    const showBibliography = () =>
      act(() => {
        window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'bibliography' }));
      });

    it('le menu « Bibliographie » pendant l’export ne fait pas perdre l’échec', async () => {
      const finish = installElectron();
      const { container } = render(<MainLayout leftPanel={<Modal isOpen onClose={vi.fn()} />} />);
      await startExport(exportLabel, exportingLabel);

      showBibliography();

      expect(screen.getByRole('button', { name: exportingLabel })).toBeInTheDocument();
      expect(screen.queryByTestId('panneau-bibliographie')).toBeNull();

      finish({ success: false, error: 'xelatex a échoué' });
      await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());
      expect(container.querySelector('.export-error')).toHaveTextContent('xelatex a échoué');
    });

    it('l’export fini, la modale fermée : le menu change de nouveau de panneau', async () => {
      const finish = installElectron();
      const { container, rerender } = render(<MainLayout leftPanel={<Modal isOpen onClose={vi.fn()} />} />);
      await startExport(exportLabel, exportingLabel);
      showBibliography();
      finish({ success: false, error: 'xelatex a échoué' });
      await waitFor(() => expect(container.querySelector('.export-error')).not.toBeNull());

      // L'erreur reste à lire : la modale ouverte, le menu ne l'emporte pas davantage.
      showBibliography();
      expect(container.querySelector('.export-error')).not.toBeNull();
      expect(screen.queryByTestId('panneau-bibliographie')).toBeNull();

      rerender(<MainLayout leftPanel={<Modal isOpen={false} onClose={vi.fn()} />} />);
      showBibliography();

      expect(screen.getByTestId('panneau-bibliographie')).toBeInTheDocument();
    });

    it('la modale ouverte, hors export, le menu ne l’emporte pas ; fermée, il change de panneau', async () => {
      installElectron();
      const { rerender } = render(<MainLayout leftPanel={<Modal isOpen onClose={vi.fn()} />} />);
      await screen.findByRole('button', { name: exportLabel });

      showBibliography();
      expect(screen.getByRole('button', { name: exportLabel })).toBeInTheDocument();
      expect(screen.queryByTestId('panneau-bibliographie')).toBeNull();

      rerender(<MainLayout leftPanel={<Modal isOpen={false} onClose={vi.fn()} />} />);
      showBibliography();

      expect(screen.getByTestId('panneau-bibliographie')).toBeInTheDocument();
    });
  },
);

/**
 * Même chose pour tout ce que le panneau gauche héberge : l'assistant de démarrage perdait ses
 * réponses sur Alt+2, sans passer par le fond ni par Échap, et la modale de création de même.
 */
describe('une modale ouverte dans le panneau gauche', () => {
  const showBibliography = () =>
    act(() => {
      window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'bibliography' }));
    });

  it('le menu « Bibliographie » ne démonte pas l’assistant de démarrage ni ses réponses', () => {
    installElectron();
    render(<MainLayout leftPanel={<OnboardingWizard projectName="demo" onComplete={vi.fn()} onSkip={vi.fn()} />} />);
    const input = document.querySelector('.onboarding-wizard__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Un sujet' } });

    showBibliography();

    expect(document.querySelector('.onboarding-wizard__input')).toHaveValue('Un sujet');
    expect(screen.queryByTestId('panneau-bibliographie')).toBeNull();
  });

  it('un panneau qui ne prend qu’Échap n’est pas une modale : le menu change de panneau', () => {
    function EscapeOnlyPanel() {
      useFocusTrap({ active: true, onEscape: vi.fn(), restoreFocus: false });
      return <div>Recherche dans le manuscrit</div>;
    }
    installElectron();
    render(<MainLayout leftPanel={<EscapeOnlyPanel />} />);

    showBibliography();

    expect(screen.getByTestId('panneau-bibliographie')).toBeInTheDocument();
  });
});

it('le menu « Bibliographie » pendant un export Word ne fait pas perdre les citations non résolues', async () => {
  const finish = installElectron();
  render(<MainLayout leftPanel={<WordExportModal isOpen onClose={vi.fn()} />} />);
  await startExport('export.word.export', 'export.word.exporting');

  act(() => {
    window.dispatchEvent(new CustomEvent('switch-panel', { detail: 'bibliography' }));
  });
  finish({ success: true, unresolvedCitations: ['absente'] });

  expect(await screen.findByTestId('word-export-unresolved')).toBeInTheDocument();
});

/**
 * BT1-4 : le style CSL du projet introuvable n'est plus écarté en silence. Le
 * document est écrit, sans ce style : la modale reste ouverte pour le dire,
 * comme pour les citations non résolues.
 */
describe.each(MODALS.filter((m) => m.name !== 'présentation'))(
  'modale d’export $name : style du projet introuvable',
  ({ Modal, exportLabel, exportingLabel }) => {
    it('le dit, et reste ouverte', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const finish = installElectron();
      const onClose = vi.fn();
      render(<Host Modal={Modal} onClose={onClose} />);
      await startExport(exportLabel, exportingLabel);

      finish({ success: true, missingCsl: '/tmp/demo/style.csl' });

      expect(await screen.findByTestId('export-csl-missing')).toHaveTextContent('export.cslMissing');
      await advance(10_000);
      expect(onClose).not.toHaveBeenCalled();
    });
  }
);

/**
 * BT1-4, revue : sans pandoc, un style du projet que le moteur interne ne sait
 * pas appliquer (dépendant, illisible) n'est pas tenté. Le document garde ses
 * clés ; la modale dit pourquoi, et reste ouverte.
 */
describe.each([
  { reason: 'dependent' as const, key: 'export.cslDependent' },
  { reason: 'unreadable' as const, key: 'export.cslUnreadable' },
])('modale d’export Word : style du projet inapplicable ($reason)', ({ reason, key }) => {
  it('le dit, et reste ouverte', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const finish = installElectron();
    const onClose = vi.fn();
    render(<Host Modal={WordExportModal} onClose={onClose} />);
    await startExport('export.word.export', 'export.word.exporting');

    finish({ success: true, unusableCsl: { path: '/tmp/demo/revue.csl', reason } });

    expect(await screen.findByTestId('export-csl-unusable')).toHaveTextContent(key);
    await advance(10_000);
    expect(onClose).not.toHaveBeenCalled();
  });
});
