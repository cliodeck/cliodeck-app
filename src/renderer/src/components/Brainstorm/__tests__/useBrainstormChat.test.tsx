// @vitest-environment jsdom
/**
 * `useBrainstormChat.send` doit transmettre au main ce que le panneau du
 * chat affiche. Jusqu'ici seul `numCtx` partait : le modèle, la
 * température, top-p et top-k restaient dans le store du renderer, et les
 * réglages de l'application décidaient seuls — « changer les paramètres
 * dans la fenêtre du chatbot n'a pas d'effet ».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useBrainstormChat } from '../useBrainstormChat';
import { useRAGQueryStore } from '../../../stores/ragQueryStore';
import { useChatStore } from '../../../stores/chatStore';

type StartOpts = Record<string, unknown> | undefined;

function installFusionChat(): ReturnType<typeof vi.fn> {
  const start = vi.fn(async (_messages: unknown[], _opts?: StartOpts) => ({
    success: true,
    sessionId: 's1',
  }));
  const unsub = (): void => undefined;
  const chat = {
    start,
    cancel: vi.fn(async () => ({ success: true })),
    onChunk: () => unsub,
    onContext: () => unsub,
    onToolCall: () => unsub,
    onExplanation: () => unsub,
    onStatus: () => unsub,
  };
  const w = window as unknown as { electron: Record<string, unknown> };
  w.electron = { ...w.electron, fusion: { chat } };
  return start;
}

function optsOf(start: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(start).toHaveBeenCalledTimes(1);
  return (start.mock.calls[0] as [unknown[], StartOpts])[1] ?? {};
}

describe('useBrainstormChat — transmission des réglages du panneau', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
  });

  it('envoie le modèle, la fenêtre de contexte et l’échantillonnage choisis', async () => {
    const start = installFusionChat();
    useRAGQueryStore.getState().setParams({
      provider: 'ollama',
      model: 'qwen3.5:35b',
      numCtx: 1_048_576,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 50,
    });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });

    expect(optsOf(start)).toMatchObject({
      model: 'qwen3.5:35b',
      numCtx: 1_048_576,
      temperature: 0.2,
      topP: 0.9,
      topK: 50,
    });
  });

  it('n’envoie pas de modèle quand la génération est confiée au modèle embarqué', async () => {
    const start = installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'embedded', model: 'qwen3.5:35b' });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });

    expect(optsOf(start)).not.toHaveProperty('model');
  });

  it('omet numCtx quand il vaut 0 (défaut du serveur Ollama)', async () => {
    const start = installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'ollama', model: 'gemma3:4b', numCtx: 0 });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });

    const opts = optsOf(start);
    expect(opts).not.toHaveProperty('numCtx');
    expect(opts.model).toBe('gemma3:4b');
  });
});
