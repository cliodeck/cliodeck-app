// @vitest-environment jsdom
/**
 * ChatInterface (Write mode) post-fusion (step 4b) roundtrip.
 *
 * Drives the fusion:chat:* mock IPC through a single user→assistant
 * exchange and asserts the rendered bubbles match the synthesized
 * stream, proving the Write UI now runs on the unified pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// Silence the RAGSettingsPanel — it pulls heavy stores we don't need here.
vi.mock('../RAGSettingsPanel', () => ({
  RAGSettingsPanel: () => null,
}));
vi.mock('../ModeSelector', () => ({
  ModeSelector: () => null,
}));
// The projection hook reaches into modeStore + ragQueryStore which require
// window.electron surfaces we don't stub here. For the projection-specific
// test we override via setChatSettings directly.
vi.mock('../useChatSettingsProjection', () => ({
  useChatSettingsProjection: () => undefined,
}));
vi.mock('../../Methodology/HelperTooltip', () => ({
  HelperTooltip: () => null,
}));

import { ChatInterface } from '../ChatInterface';
import { useChatStore } from '../../../stores/chatStore';
import { useCloudConsentStore } from '../../../stores/cloudConsentStore';

type ChunkCb = (env: { sessionId: string; chunk: { delta: string; done?: boolean; finishReason?: string } }) => void;

interface MockApi {
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  onChunk: ReturnType<typeof vi.fn>;
  onContext: ReturnType<typeof vi.fn>;
  onToolCall: ReturnType<typeof vi.fn>;
  onExplanation: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  // Test handles:
  _emitChunk: ChunkCb;
  _emitStatus: (env: { sessionId: string; status: { phase: string; label?: string } }) => void;
}

function installFusionMock(
  llmConfig: { backend: string; ollamaURL?: string } = {
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:11434',
  }
): MockApi {
  let chunkCb: ChunkCb = () => {};
  let statusCb: (env: { sessionId: string; status: { phase: string; label?: string } }) => void =
    () => {};
  const api = {
    start: vi.fn(async () => ({ success: true, sessionId: 'sess-test-1' })),
    cancel: vi.fn(async () => ({ success: true, cancelled: true })),
    onChunk: vi.fn((cb: ChunkCb) => {
      chunkCb = cb;
      return () => undefined;
    }),
    onContext: vi.fn(() => () => undefined),
    onToolCall: vi.fn(() => () => undefined),
    onExplanation: vi.fn(() => () => undefined),
    onStatus: vi.fn((cb: typeof statusCb) => {
      statusCb = cb;
      return () => undefined;
    }),
  };
  (window as unknown as { electron: unknown }).electron = {
    fusion: { chat: api },
    // Le garde de consentement cloud (useCloudConsentGuard) lit la config
    // LLM au montage — défaut local pour ne pas déclencher le dialogue.
    config: { get: vi.fn(async () => llmConfig) },
  } as never;
  Object.defineProperty(api, '_emitChunk', {
    get: () => chunkCb,
  });
  Object.defineProperty(api, '_emitStatus', {
    get: () => statusCb,
  });
  return api as unknown as MockApi;
}

describe('ChatInterface (fusion step 4b)', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('send → start → stream → done renders the assistant reply', async () => {
    const api = installFusionMock();
    render(<ChatInterface />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'bonjour' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));

    // The server acknowledges → the store assigns a pending assistant.
    await waitFor(() => {
      expect(useChatStore.getState().pendingAssistantId).not.toBeNull();
    });

    // Emit a delta then done.
    act(() => {
      api._emitChunk({ sessionId: 'sess-test-1', chunk: { delta: 'Salut !' } });
    });
    act(() => {
      api._emitChunk({ sessionId: 'sess-test-1', chunk: { delta: '', done: true, finishReason: 'stop' } });
    });

    await waitFor(() => {
      const msgs = useChatStore.getState().messages;
      expect(msgs.some((m) => m.role === 'user' && m.content === 'bonjour')).toBe(true);
      expect(
        msgs.some((m) => m.role === 'assistant' && m.content === 'Salut !' && !m.pending)
      ).toBe(true);
    });
  });

  it('renders a polite status banner while fusion:chat:status streams retrieving/generating', async () => {
    const api = installFusionMock();
    render(<ChatInterface />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'question' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(api.start).toHaveBeenCalled());

    act(() => {
      api._emitStatus({
        sessionId: 'sess-test-1',
        status: { phase: 'retrieving', label: 'Recherche en cours' },
      });
    });
    await waitFor(() => {
      const banner = screen.getByRole('status');
      expect(banner).toHaveAttribute('aria-live', 'polite');
      expect(banner.textContent).toContain('Recherche');
    });

    act(() => {
      api._emitStatus({
        sessionId: 'sess-test-1',
        status: { phase: 'generating', label: 'Génération' },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Génération');
    });
  });

  it('forwards chatSettings (modeId + retrieval source toggles) in the start payload', async () => {
    const api = installFusionMock();
    // Seed chatSettings directly — the projection hook is mocked out.
    useChatStore.getState().setChatSettings({
      modeId: 'analytical',
      customSystemPrompt: 'Stay factual.',
      retrieval: {
        topK: 5,
        sourceType: 'primary',
        includeVault: true,
      },
    });
    render(<ChatInterface />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'ping' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    const [, startOpts] = api.start.mock.calls[0];
    expect(startOpts.systemPrompt).toBeDefined();
    expect(startOpts.systemPrompt.modeId).toBe('analytical');
    expect(startOpts.systemPrompt.customText).toBe('Stay factual.');
    expect(startOpts.retrievalOptions).toMatchObject({
      sourceType: 'primary',
      includeVault: true,
      topK: 5,
    });
  });

  // ADR 0005 : ce panneau envoyait au cloud SANS dialogue de consentement
  // (docs/chat-unification-etat-des-lieux.md §2.1). Ce test verrouille le
  // garde partagé useCloudConsentGuard.
  it('cloud provider → consent dialog gates the send until confirmed', async () => {
    useCloudConsentStore.setState({ consented: false, consentedProvider: null });
    const api = installFusionMock({ backend: 'claude' });
    render(<ChatInterface />);

    // Laisse le hook lire la config LLM mockée.
    await waitFor(() =>
      expect(
        (window as unknown as { electron: { config: { get: ReturnType<typeof vi.fn> } } })
          .electron.config.get
      ).toHaveBeenCalled()
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'question sensible' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    // Le dialogue apparaît, rien ne part vers le provider.
    await waitFor(() =>
      expect(document.querySelector('.cloud-consent-dialog')).not.toBeNull()
    );
    expect(api.start).not.toHaveBeenCalled();

    // Confirmation → l'envoi différé part, une seule fois.
    const confirmBtn = document.querySelector(
      '.cloud-consent-dialog__btn:not(.cloud-consent-dialog__btn--cancel)'
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
    expect(useCloudConsentStore.getState().consented).toBe(true);
  });
});
