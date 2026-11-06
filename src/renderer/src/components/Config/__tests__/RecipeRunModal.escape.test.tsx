// @vitest-environment jsdom
/**
 * Fermer la fenêtre d'exécution d'une recette : jamais par mégarde pendant qu'elle tourne.
 *
 * Elle n'avait pas de piège : Échap fermait les Réglages qui la contiennent, et la fenêtre partait
 * avec son journal alors que la recette continuait côté main (S17-1-22). Mais Échap était aussi la
 * seule sortie, le X étant désactivé : une étape bloquée ne doit pas obliger à quitter l'app. Elle
 * se ferme donc encore pendant l'exécution, après une question qui dit que la recette continue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const slot = vi.hoisted(() => ({ content: null as ReactNode }));
vi.mock('../ConfigPanel', () => ({ ConfigPanel: () => slot.content }));
// Un `t` stable, comme le vrai : la modale recharge sa recette quand il change.
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

import { ConfirmDialog } from '../../common/ConfirmDialog';
import { useDialogStore } from '../../../stores/dialogStore';
import { RecipeRunModal } from '../RecipeRunModal';
import { SettingsModal } from '../SettingsModal';

const dialogs = () => useDialogStore.getState();
const closeRun = vi.fn();
const closeSettings = vi.fn();
let finishRun: (result: { success: boolean; ok?: boolean; logPath?: string }) => void;

const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const pressEscape = () =>
  act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
const runOverlay = () => document.querySelectorAll('.settings-modal')[1] as HTMLElement;
const clickBackdrop = () =>
  act(async () => {
    fireEvent.mouseDown(runOverlay());
    fireEvent.mouseUp(runOverlay());
    fireEvent.click(runOverlay());
  });
const startRun = () =>
  act(async () => {
    fireEvent.click(screen.getByText('recipeRun.buttons.run'));
  });
const endRun = () =>
  act(async () => {
    finishRun({ success: true, ok: true, logPath: '/tmp/journal.jsonl' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

/** Une recette à paramètres : le plan part sur plusieurs lignes, dans un `textarea`. */
function withPlan(): void {
  const recipes = (window as unknown as { electron: { fusion: { recipes: { read: ReturnType<typeof vi.fn> } } } })
    .electron.fusion.recipes;
  recipes.read.mockResolvedValue({
    success: true,
    recipe: {
      name: 'ma-recette',
      version: '1',
      description: '',
      inputs: { plan: { type: 'string', required: true } },
      steps: [{ id: 's1', kind: 'write' }],
      outputs: {},
    },
  });
}
const plan = () => runOverlay().querySelector('textarea') as HTMLTextAreaElement;
const typePlan = (value: string) => fireEvent.change(plan(), { target: { value } });

async function renderRun(): Promise<void> {
  slot.content = <RecipeRunModal scope="user" fileName="ma-recette.yaml" onClose={closeRun} />;
  render(
    <>
      <SettingsModal isOpen onClose={closeSettings} />
      <ConfirmDialog />
    </>
  );
  await settle();
}

beforeEach(() => {
  closeRun.mockClear();
  closeSettings.mockClear();
  (window as unknown as { electron: unknown }).electron = {
    fusion: {
      recipes: {
        read: vi.fn(async () => ({
          success: true,
          recipe: { name: 'ma-recette', version: '1', description: '', inputs: {}, steps: [{ id: 's1', kind: 'write' }], outputs: {} },
        })),
        run: vi.fn(() => new Promise((resolve) => (finishRun = resolve))),
        cancel: vi.fn(async () => ({ success: true })),
        onEvent: vi.fn(() => () => undefined),
      },
    },
  };
});

afterEach(() => {
  while (dialogs().confirmOpen) dialogs().resolveConfirm(false);
  cleanup();
});

describe('RecipeRunModal', () => {
  it('avant de lancer : Échap la ferme, et elle seule', async () => {
    await renderRun();

    await pressEscape();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('pendant l’exécution : le fond ne ferme rien, et Échap ne ferme qu’après une question', async () => {
    await renderRun();
    await startRun();
    expect(screen.getByText('recipeRun.buttons.running')).toBeTruthy();

    await clickBackdrop();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeRun).not.toHaveBeenCalled();

    await pressEscape();
    expect(dialogs().confirmOpen).toBe(true);
    expect(dialogs().confirmMessage).toBe('recipeRun.closeWhileRunning');
    expect(closeRun).not.toHaveBeenCalled();

    // Le second Échap répond à la question, en la refusant : la fenêtre reste, et l'exécution aussi.
    await pressEscape();
    expect(dialogs().confirmOpen).toBe(false);
    expect(closeRun).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(screen.getByText('recipeRun.buttons.running')).toBeTruthy();
    await endRun();
  });

  it('pendant l’exécution : une étape bloquée ne bloque pas l’app, la fenêtre se ferme par le X après la question', async () => {
    await renderRun();
    await startRun();
    const close = runOverlay().querySelector('.close-btn') as HTMLButtonElement;
    expect(close).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(close);
    });
    expect(dialogs().confirmOpen).toBe(true);
    expect(closeRun).not.toHaveBeenCalled();

    await act(async () => {
      dialogs().resolveConfirm(true);
    });
    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
    await endRun();
  });

  it('une exécution finie se ferme par Échap', async () => {
    await renderRun();
    await startRun();
    await endRun();

    await pressEscape();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('des paramètres saisis : ni le fond ni Échap ne ferment, et la saisie reste', async () => {
    withPlan();
    await renderRun();
    typePlan('Un long plan\nsur plusieurs lignes');

    await clickBackdrop();
    await pressEscape();

    expect(closeRun).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();
    expect(plan().value).toBe('Un long plan\nsur plusieurs lignes');
  });

  it('des paramètres saisis : le X reste un geste franc', async () => {
    withPlan();
    await renderRun();
    typePlan('Un plan');

    fireEvent.click(runOverlay().querySelector('.close-btn') as HTMLElement);

    expect(closeRun).toHaveBeenCalledTimes(1);
  });

  it('un paramètre revenu à sa valeur de départ : plus rien à perdre, le fond ferme', async () => {
    withPlan();
    await renderRun();
    typePlan('Un plan');
    typePlan('');

    await clickBackdrop();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('rien de saisi : le fond ferme, et lui seul', async () => {
    withPlan();
    await renderRun();

    await clickBackdrop();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('une exécution finie avec des paramètres se ferme, tant qu’on ne les a pas modifiés de nouveau', async () => {
    withPlan();
    await renderRun();
    typePlan('Un plan');
    await startRun();
    await endRun();

    typePlan('Un autre plan');
    await clickBackdrop();
    expect(closeRun).not.toHaveBeenCalled();

    typePlan('Un plan');
    await clickBackdrop();
    expect(closeRun).toHaveBeenCalledTimes(1);
  });

  it('une exécution finie se ferme par le fond', async () => {
    await renderRun();
    await startRun();
    await endRun();

    await clickBackdrop();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });
});

/** Fermer la fenêtre d'une recette en cours l'annule (D20), et seulement celle-là. */
describe('RecipeRunModal : fermer annule', () => {
  const recipes = () =>
    (window as unknown as {
      electron: { fusion: { recipes: { run: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } } };
    }).electron.fusion.recipes;
  const runIdSent = () => recipes().run.mock.calls[0][3] as string;

  it('confirmer la fermeture d’une recette en cours annule la passe lancée par cette fenêtre', async () => {
    await renderRun();
    await startRun();

    await pressEscape();
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(runIdSent()).toEqual(expect.any(String));
    expect(recipes().cancel).toHaveBeenCalledTimes(1);
    expect(recipes().cancel).toHaveBeenCalledWith(runIdSent());
    await endRun();
  });

  it('refuser la question n’annule rien', async () => {
    await renderRun();
    await startRun();

    await pressEscape();
    await pressEscape();

    expect(recipes().cancel).not.toHaveBeenCalled();
    await endRun();
  });

  it('une recette terminée se ferme sans question et sans annulation', async () => {
    await renderRun();
    await startRun();
    await endRun();

    fireEvent.click(runOverlay().querySelector('.close-btn') as HTMLElement);

    expect(dialogs().confirmOpen).toBe(false);
    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(recipes().cancel).not.toHaveBeenCalled();
  });

  it('chaque lancement a son identifiant : annuler ne vise jamais une passe précédente', async () => {
    await renderRun();
    await startRun();
    await endRun();
    await startRun();

    await pressEscape();
    await act(async () => {
      dialogs().resolveConfirm(true);
    });

    const [first, second] = recipes().run.mock.calls.map((call) => call[3] as string);
    expect(second).not.toBe(first);
    expect(recipes().cancel).toHaveBeenCalledWith(second);
    await endRun();
  });
});
