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
import { useNotificationStore } from '../../../stores/notificationStore';
import { projectLifecycle } from '../../../lifecycle/projectLifecycle';

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

describe('useBrainstormChat — des cases cochées dont aucune ne sera consultée bloquent l’envoi', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useNotificationStore.setState({ notifications: [] });
  });
  afterEach(() => {
    cleanup();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: undefined });
  });

  it('ne part pas, n’ajoute aucun message, et dit pourquoi', async () => {
    // Notes de lecture seules cochées, fournisseur distant sans consentement :
    // avant, le tour partait soit sans aucun contexte, soit — après la revue —
    // vers toutes les sources. Ni l'un ni l'autre n'est ce qui a été coché.
    const start = installFusionChat();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: ['chat.scope.reason.cloud'] });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('qu’ai-je noté sur Braudel ?');
    });

    expect(start).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
    const notes = useNotificationStore.getState().notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0].level).toBe('warning');
    // Le simulacre i18n rend la clé sans interpolation : la raison est
    // observable dans `details`, que l'interface réelle affiche aussi.
    expect(notes[0].title).toBe('chat.scope.nothingConsultedTitle');
    expect(notes[0].details).toContain('chat.scope.reason.cloud');
  });

  it('part normalement quand rien ne bloque', async () => {
    const start = installFusionChat();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: undefined });
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ouvrir un autre projet pendant une génération annule le tour, et la conversation affichée est
 * vidée (Q11). L'envoi parti dans A ne doit rien afficher dans B : ni la réponse, ni même son
 * attente. Vu dans l'app (L03-3b) : la question posée dans un projet restait affichée dans le suivant.
 */
describe('useBrainstormChat — un envoi parti avant la bascule', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: undefined });
    projectLifecycle.enter('/projets/A');
  });
  afterEach(() => {
    cleanup();
  });

  it('chat.start répond après le passage à B : rien ne s’affiche dans B, et la session est annulée', async () => {
    const start = installFusionChat();
    let answer!: (value: { success: boolean; sessionId?: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const cancel = (window as unknown as { electron: { fusion: { chat: { cancel: ReturnType<typeof vi.fn> } } } })
      .electron.fusion.chat.cancel;

    const { result } = renderHook(() => useBrainstormChat());
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('Qui était le préfet en 1934 ?');
    });
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['Qui était le préfet en 1934 ?']);

    act(() => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    await act(async () => {
      answer({ success: true, sessionId: 's1' });
      await sending;
    });
    act(() => {
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: 'Le préfet était…' } });
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: '', done: true, finishReason: 'cancelled' } });
    });

    expect(useChatStore.getState().messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(cancel).toHaveBeenCalledWith('s1');
  });

  it('chat.start échoue après le passage à B : aucun message d’erreur dans B', async () => {
    const start = installFusionChat();
    let answer!: (value: { success: boolean; error?: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const { result } = renderHook(() => useBrainstormChat());
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    await act(async () => {
      answer({ success: false, error: 'project-closed' });
      await sending;
    });

    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('témoin : chat.start répond dans le même projet, la réponse s’affiche', async () => {
    installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: 'Le préfet était…', done: true, finishReason: 'stop' } });
    });

    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'Qui était le préfet en 1934 ?',
      'Le préfet était…',
    ]);
  });
});

/**
 * Un tour resté sans réponse garde sa bulle vide à l'écran (S06-1-1). Renvoyée au modèle avec la
 * question suivante, elle faisait échouer en HTTP 400 chaque tour d'après chez Claude et Gemini,
 * jusqu'à ce qu'on vide la conversation.
 */
describe('useBrainstormChat — un tour sans réponse ne repart pas au modèle', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: undefined });
  });
  afterEach(() => {
    cleanup();
  });

  function sentMessages(start: ReturnType<typeof vi.fn>, call: number): unknown[] {
    return (start.mock.calls[call] as [unknown[], StartOpts])[0];
  }

  it('tour en erreur avant le premier jeton : la question suivante part sans la bulle vide ni sa question', async () => {
    const start = installFusionChat();
    start
      .mockResolvedValueOnce({ success: true, sessionId: 's1' })
      .mockResolvedValueOnce({ success: true, sessionId: 's2' })
      .mockResolvedValueOnce({ success: true, sessionId: 's3' });
    const { result } = renderHook(() => useBrainstormChat());

    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: 'Jean Chiappe.', done: true, finishReason: 'stop' } });
    });
    await act(async () => {
      await result.current.send('Et en 1936 ?');
    });
    act(() => {
      chunkListeners[0]({
        sessionId: 's2',
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'provider_error', message: 'HTTP 529 overloaded' },
      });
    });
    // La bulle du tour échoué reste affichée, avec son erreur.
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      isError: true,
    });

    await act(async () => {
      await result.current.send('Qui lui a succédé ?');
    });

    expect(start).toHaveBeenCalledTimes(3);
    expect(sentMessages(start, 2)).toEqual([
      { role: 'user', content: 'Qui était le préfet en 1934 ?' },
      { role: 'assistant', content: 'Jean Chiappe.' },
      { role: 'user', content: 'Qui lui a succédé ?' },
    ]);
  });

  it('tour arrêté avant le premier jeton : même sort', async () => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      finishReason: 'cancelled',
    });

    await act(async () => {
      await result.current.send('Et en 1936 ?');
    });

    expect(sentMessages(start, 1)).toEqual([{ role: 'user', content: 'Et en 1936 ?' }]);
  });

  it('chat.start refusé (bulle local-error) : même sort', async () => {
    const start = installFusionChat();
    start.mockResolvedValueOnce({ success: false, error: 'boom' } as never);
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({ role: 'assistant', content: '', isError: true });

    await act(async () => {
      await result.current.send('Et en 1936 ?');
    });

    expect(sentMessages(start, 1)).toEqual([{ role: 'user', content: 'Et en 1936 ?' }]);
  });

  it('témoin : un tour partiel interrompu repart avec sa question', async () => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      chunkListeners[0]({ sessionId: 's1', chunk: { delta: 'Le préfet était' } });
      chunkListeners[0]({
        sessionId: 's1',
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'stream_error', message: 'socket hang up' },
      });
    });
    await act(async () => {
      await result.current.send('Continue.');
    });

    expect(sentMessages(start, 1)).toEqual([
      { role: 'user', content: 'Qui était le préfet en 1934 ?' },
      { role: 'assistant', content: 'Le préfet était' },
      { role: 'user', content: 'Continue.' },
    ]);
  });
});
