// @vitest-environment jsdom
/**
 * Le fond de l'assistant de démarrage : il ferme quand rien ne s'y perd, et seulement alors.
 *
 * `onClick={onSkip}` fermait l'assistant dès qu'une sélection de texte débordait de la carte, et
 * un clic à côté faisait de même : les réponses saisies partaient sans un mot (S17-1-20).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OnboardingWizard } from '../OnboardingWizard';

const backdrop = () => document.querySelector('.onboarding-wizard') as HTMLElement;
const card = () => document.querySelector('.onboarding-wizard__card') as HTMLElement;
const topic = () => screen.getByPlaceholderText('onboarding.topicPlaceholder');
const clickBackdrop = () => {
  fireEvent.mouseDown(backdrop());
  fireEvent.mouseUp(backdrop());
  fireEvent.click(backdrop());
};
const pressEscape = () => fireEvent.keyDown(document, { key: 'Escape' });

function renderWizard(onComplete: (hints: string) => Promise<boolean> = async () => true) {
  const onSkip = vi.fn();
  render(<OnboardingWizard projectName="Danzig" onComplete={onComplete} onSkip={onSkip} />);
  return onSkip;
}

/** Jusqu'au dernier écran de questions. */
async function answerUpToLanguage(): Promise<void> {
  fireEvent.change(topic(), { target: { value: 'Ports baltes' } });
  for (let step = 0; step < 3; step += 1) {
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.next'));
    });
  }
}

afterEach(() => cleanup());

describe('OnboardingWizard : le fond', () => {
  it('une sélection qui part de la carte et finit sur le fond ne ferme rien', () => {
    const onSkip = renderWizard();

    fireEvent.mouseDown(card());
    fireEvent.mouseUp(backdrop());
    fireEvent.click(backdrop());

    expect(onSkip).not.toHaveBeenCalled();
  });

  it('rien de saisi : un clic sur le fond ferme', () => {
    const onSkip = renderWizard();

    clickBackdrop();

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('des réponses saisies : un clic à côté de la carte ne les perd pas', () => {
    const onSkip = renderWizard();
    fireEvent.change(topic(), { target: { value: 'Ports baltes' } });

    clickBackdrop();

    expect(onSkip).not.toHaveBeenCalled();
    expect(topic()).toHaveValue('Ports baltes');
  });

  it('un sujet réduit à des espaces n’est pas une réponse', () => {
    const onSkip = renderWizard();
    fireEvent.change(topic(), { target: { value: '   ' } });

    clickBackdrop();

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('des réponses saisies : le X et le lien « Passer » restent des gestes francs', async () => {
    const onSkip = renderWizard();
    await answerUpToLanguage();

    fireEvent.click(document.querySelector('.onboarding-wizard__close') as HTMLElement);
    expect(onSkip).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('onboarding.skipSetup'));
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it('le fichier n’a pas pu être écrit : les réponses restent protégées', async () => {
    const onSkip = renderWizard(async () => false);
    await answerUpToLanguage();
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.finish'));
    });
    expect(screen.queryByText('onboarding.doneMessage')).toBeNull();

    clickBackdrop();

    expect(onSkip).not.toHaveBeenCalled();
  });

  it('écran de fin : il s’affiche, et le fond ferme de nouveau, les réponses étant écrites', async () => {
    const onSkip = renderWizard();
    await answerUpToLanguage();
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.finish'));
    });
    expect(screen.getByText('onboarding.doneMessage')).toBeTruthy();
    expect(onSkip).not.toHaveBeenCalled();

    clickBackdrop();

    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});

describe('OnboardingWizard : Échap suit la même règle', () => {
  it('rien de saisi : ferme', () => {
    const onSkip = renderWizard();

    pressEscape();

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('des réponses saisies : ne perd rien', () => {
    const onSkip = renderWizard();
    fireEvent.change(topic(), { target: { value: 'Ports baltes' } });

    pressEscape();

    expect(onSkip).not.toHaveBeenCalled();
  });

  it('écran de fin : ferme', async () => {
    const onSkip = renderWizard();
    await answerUpToLanguage();
    await act(async () => {
      fireEvent.click(screen.getByText('onboarding.finish'));
    });

    pressEscape();

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('Tab reste dans la carte', async () => {
    renderWizard();
    await answerUpToLanguage();
    // L'écran de la langue n'a pas de champ : le focus est retombé sur la page.
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(card().contains(document.activeElement)).toBe(true);
  });
});
