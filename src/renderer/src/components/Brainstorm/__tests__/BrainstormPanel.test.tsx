// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrainstormPanel } from '../BrainstormPanel';
import { useProjectStore } from '../../../stores/projectStore';
import { loadWorkspaceHints } from '../../../../../../backend/core/hints/loader';
import { symlinkAvailable } from '../../../../../../backend/__tests__/helpers/native-guards';

// The real BrainstormChat drags in zustand stores that touch `window.electron`
// in ways unrelated to this test — keep it isolated.
vi.mock('../BrainstormChat', () => ({
  BrainstormChat: () => <div data-testid="brainstorm-chat-stub" />,
}));

const setFusion = (overrides: {
  hintsError?: string;
  hintsOk?: boolean;
}): void => {
  const fusion = {
    hints: {
      read: vi.fn().mockResolvedValue(
        overrides.hintsOk
          ? {
              success: true,
              hints: {
                present: false,
                raw: '',
                normalized: '',
                sourcePath: '.cliodeck/hints.md',
              },
            }
          : { success: false, error: overrides.hintsError ?? 'no_project' }
      ),
    },
    recipes: {
      list: vi.fn().mockResolvedValue({ success: true, builtin: [], user: [] }),
    },
    vault: {
      status: vi.fn().mockResolvedValue({ success: true, indexed: false, dbPath: '' }),
    },
  };
  (window as unknown as { electron: { fusion: typeof fusion } }).electron = {
    ...(window as unknown as { electron: Record<string, unknown> }).electron,
    fusion,
  } as never;
};

describe('BrainstormPanel — project-aware loading', () => {
  beforeEach(() => {
    useProjectStore.setState({ currentProject: null });
  });
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ currentProject: null });
  });

  it('shows a neutral notice (not a red error) when no project is open, then clears it once a project is opened', async () => {
    // Initially: no project. Fusion API doesn't even get called, but set a
    // sensible default in case something probes it.
    setFusion({ hintsOk: true });

    render(<BrainstormPanel />);

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/openProjectNotice|Open a project|Ouvrez un projet/i);
    // And crucially: no red error banner.
    expect(screen.queryByRole('alert')).toBeNull();

    // Now a project opens.
    act(() => {
      useProjectStore.setState({
        currentProject: {
          id: 'p1',
          name: 'Test',
          path: '/tmp/test-project',
          type: 'article',
          createdAt: new Date(),
          lastOpenedAt: new Date(),
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/**
 * Le tiroir disait « Aucun fichier » d'un `context.md` qu'on n'a pas lu. Hors des Réglages et de
 * l'assistant, c'est tout ce que l'auteur voyait d'un contexte qui ne part plus au modèle. Le vrai
 * chargeur sur un vrai dossier : la forme de ce qu'il rend est ce qui se joue ici.
 */
describe('BrainstormPanel — context.md dans le tiroir', () => {
  let project: string;
  let outside: string;
  let contextMd: string;

  /** Les consignes telles que le chargeur les rend pour ce dossier, tiroir ouvert. */
  async function openDrawer(): Promise<void> {
    const hints = await loadWorkspaceHints(project);
    (window as unknown as { electron: { fusion: unknown } }).electron = {
      ...(window as unknown as { electron: Record<string, unknown> }).electron,
      fusion: {
        hints: { read: vi.fn().mockResolvedValue({ success: true, hints }) },
        recipes: { list: vi.fn().mockResolvedValue({ success: true, builtin: [], user: [] }) },
        vault: { status: vi.fn().mockResolvedValue({ success: true, indexed: false, dbPath: '' }) },
      },
    };
    useProjectStore.setState({
      currentProject: {
        id: 'p1',
        name: 'Danzig',
        path: project,
        type: 'article',
        createdAt: new Date(),
        lastOpenedAt: new Date(),
      },
    });
    render(<BrainstormPanel />);
    fireEvent.click(await screen.findByText('chat.brainstorm.projectContext'));
    // Les trois lectures arrivent ensemble : tant qu'elles manquent, le tiroir dit « aucun fichier ».
    await waitFor(() => expect(screen.queryByText('chat.brainstorm.vaultChecking')).toBeNull());
  }

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tiroir-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tiroir-dehors-'));
    contextMd = path.join(project, 'context.md');
  });
  afterEach(() => {
    cleanup();
    useProjectStore.setState({ currentProject: null });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('absent : le tiroir propose de l’ajouter, sans alerte', async () => {
    await openDrawer();

    expect(screen.queryByText('chat.brainstorm.noHints')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('pas en UTF-8 : le vrai motif, jamais « aucun fichier »', async () => {
    fs.writeFileSync(contextMd, Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]));

    await openDrawer();

    expect(screen.getByRole('alert').textContent).toContain('hints.reasons.notUtf8');
    expect(screen.queryByText('chat.brainstorm.noHints')).toBeNull();
  });

  it('un dossier à sa place : le vrai motif', async () => {
    fs.mkdirSync(contextMd);

    await openDrawer();

    expect(screen.getByRole('alert').textContent).toContain('hints.reasons.unreadable');
    expect(screen.queryByText('chat.brainstorm.noHints')).toBeNull();
  });

  it.skipIf(!symlinkAvailable)('lien qui sort du projet : le vrai motif', async () => {
    const journal = path.join(outside, 'journal.md');
    fs.writeFileSync(journal, 'Texte privé.');
    fs.symlinkSync(journal, contextMd);

    await openDrawer();

    expect(screen.getByRole('alert').textContent).toContain('hints.reasons.outsideProject');
    expect(screen.queryByText('chat.brainstorm.noHints')).toBeNull();
    expect(document.body.textContent).not.toContain('Texte privé.');
  });

  it('illisible, avec d’anciennes consignes qui partent encore : le tiroir dit les deux', async () => {
    fs.writeFileSync(contextMd, Buffer.from([0x23, 0x20, 0xc9, 0x74, 0xe9, 0x0a]));
    fs.mkdirSync(path.join(project, '.cliodeck'));
    fs.writeFileSync(path.join(project, '.cliodeck', 'hints.md'), 'Anciennes consignes.\n');

    await openDrawer();

    expect(screen.getByRole('alert').textContent).toContain('hints.reasons.notUtf8');
    expect(document.querySelector('.brainstorm-panel__hints')?.textContent).toContain('Anciennes consignes.');
  });

  it('lisible : le texte qui part, sans alerte', async () => {
    fs.writeFileSync(contextMd, '# Danzig\n\nLa ville libre.\n');

    await openDrawer();

    expect(document.querySelector('.brainstorm-panel__hints')?.textContent).toContain('La ville libre.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
