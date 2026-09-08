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
type ChunkEnvelope = {
  sessionId: string;
  chunk: { delta: string; thinking?: string; done?: boolean; finishReason?: string };
  error?: { code: string; message: string };
};

const chunkListeners: Array<(env: ChunkEnvelope) => void> = [];

function installFusionChat(): ReturnType<typeof vi.fn> {
  chunkListeners.length = 0;
  const start = vi.fn(async (_messages: unknown[], _opts?: StartOpts) => ({
    success: true,
    sessionId: 's1',
  }));
  const unsub = (): void => undefined;
  const chat = {
    start,
    cancel: vi.fn(async () => ({ success: true })),
    onChunk: (cb: (env: ChunkEnvelope) => void) => {
      chunkListeners.push(cb);
      return unsub;
    },
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
      repeat_penalty: 1.15,
      timeout: 600_000,
      think: false,
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
      repeatPenalty: 1.15,
      timeoutMs: 600_000,
      think: false,
    });
  });

  it('accumule les chunks de raisonnement à part de la réponse', async () => {
    installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'ollama', model: 'qwen3.5:35b' });
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    act(() => {
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: '', thinking: 'hmm' } });
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: 'Réponse' } });
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: '', done: true, finishReason: 'stop' } });
    });
    const last = useChatStore.getState().messages.at(-1);
    expect(last?.thinking).toBe('hmm');
    expect(last?.content).toBe('Réponse');
  });

  it('traduit le délai d’inactivité dépassé en message d’erreur localisé', async () => {
    installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'ollama', model: 'gemma3:4b', timeout: 300_000 });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    expect(chunkListeners).toHaveLength(1);
    act(() => {
      chunkListeners[0]({
        sessionId: 's1',
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'timeout', message: 'message côté main' },
      });
    });
    // Le mock de react-i18next renvoie la clé quand des variables sont
    // passées : c'est la clé localisée qui doit sortir, pas le message brut.
    expect(result.current.error).toBe('chat.timeout');
    expect(result.current.isStreaming).toBe(false);
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
