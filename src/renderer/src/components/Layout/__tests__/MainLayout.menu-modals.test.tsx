// @vitest-environment jsdom
/**
 * Le menu n'ouvre pas une modale par-dessus une autre.
 *
 * Ses accélérateurs passent par-dessus le fond. Or deux modales de la même couche s'empilent à
 * l'écran dans l'ordre du DOM, et dans la pile dans l'ordre d'ouverture : l'export demandé depuis
 * les Réglages restait caché derrière eux, tout en recevant Tab et Échap.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../Bibliography/BibliographyPanel', () => ({ BibliographyPanel: () => null }));
vi.mock('../../Chat/AssistantChat', () => ({ AssistantChat: () => null }));
vi.mock('../../Project/ProjectPanel', () => ({ ProjectPanel: () => null }));
vi.mock('../../Brainstorm/BrainstormPanel', () => ({ BrainstormPanel: () => null }));
vi.mock('../StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../../common/StatusToast', () => ({ StatusToast: () => null }));

// Le contenu des modales ne compte pas ici : seulement ce que le menu ouvre. Un clic la referme.
vi.mock('../../Config/SettingsModal', () => ({
  SettingsModal: ({ onClose }: { onClose: () => void }) => <button data-testid="settings" onClick={onClose} />,
}));
vi.mock('../../UsageJournal/UsageJournalModal', () => ({
  UsageJournalModal: ({ onClose }: { onClose: () => void }) => <button data-testid="journal" onClick={onClose} />,
}));
vi.mock('../../Export/PDFExportModal', () => ({
  PDFExportModal: ({ onClose }: { onClose: () => void }) => <button data-testid="export" onClick={onClose} />,
}));
vi.mock('../../About/AboutModal', () => ({
  AboutModal: ({ onClose }: { onClose: () => void }) => <button data-testid="about" onClick={onClose} />,
}));

import { MainLayout } from '../MainLayout';
import { HelpModal } from '../../common/HelpModal';

afterEach(() => cleanup());

const openedModal = (
  <HelpModal isOpen onClose={vi.fn()} title="Aide">
    texte
  </HelpModal>
);

const fromMenu = (event: string) =>
  act(async () => {
    window.dispatchEvent(new CustomEvent(event));
  });

describe('le menu et les modales', () => {
  it.each([
    ['Réglages', 'show-settings-modal', 'settings'],
    ['Journal d’usage', 'show-usage-journal', 'journal'],
    ['Export PDF', 'show-pdf-export-dialog', 'export'],
    ['À propos', 'show-about-dialog', 'about'],
  ])('%s : rien ne s’ouvre tant qu’une modale est ouverte, et la demande n’est pas gardée pour plus tard', async (_name, event, testId) => {
    // D'abord sans modale : le module paresseux est chargé, la suite n'a plus rien à attendre.
    const { rerender } = render(<MainLayout />);
    await fromMenu(event);
    fireEvent.click(await screen.findByTestId(testId));
    expect(screen.queryByTestId(testId)).toBeNull();

    rerender(<MainLayout leftPanel={openedModal} />);
    await fromMenu(event);
    expect(screen.queryByTestId(testId)).toBeNull();

    rerender(<MainLayout />);
    await act(async () => undefined);
    expect(screen.queryByTestId(testId)).toBeNull();

    await fromMenu(event);
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });
});
