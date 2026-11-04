// @vitest-environment jsdom
/**
 * Fermer la fenêtre d'exécution d'une recette : jamais pendant qu'elle tourne.
 *
 * Elle n'avait pas de piège : Échap fermait les Réglages qui la contiennent, et la fenêtre partait
 * avec son journal alors que la recette continuait côté main (S17-1-22).
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

import { RecipeRunModal } from '../RecipeRunModal';
import { SettingsModal } from '../SettingsModal';

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
  render(<SettingsModal isOpen onClose={closeSettings} />);
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
        onEvent: vi.fn(() => () => undefined),
      },
    },
  };
});

afterEach(() => cleanup());

describe('RecipeRunModal', () => {
  it('avant de lancer : Échap la ferme, et elle seule', async () => {
    await renderRun();

    await pressEscape();

    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
  });

  it('pendant l’exécution : ni Échap ni le fond ne ferment, et le X reste désactivé', async () => {
    await renderRun();
    await startRun();
    expect(screen.getByText('recipeRun.buttons.running')).toBeTruthy();
    expect(runOverlay().querySelector('.close-btn')).toBeDisabled();

    await pressEscape();
    await clickBackdrop();

    expect(closeRun).not.toHaveBeenCalled();
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
