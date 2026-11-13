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
import i18n from '../../../i18n';

type StartOpts = Record<string, unknown> | undefined;
type ChunkEnvelope = {
  sessionId: string;
  chunk: { delta: string; thinking?: string; done?: boolean; finishReason?: string };
  error?: { code: string; message: string };
};

const chunkListeners: Array<(env: ChunkEnvelope) => void> = [];

/** Ce que le main enverrait sur `fusion:chat:chunk`, à tous les abonnés du moment. */
function emit(env: ChunkEnvelope): void {
  for (const cb of [...chunkListeners]) cb(env);
}

/**
 * Le canal `fusion:chat:*` du preload. Un abonnement se défait vraiment : un composant démonté
 * n'entend plus rien, comme dans l'app. `start` rend l'identifiant qu'il reçoit, comme le main
 * (L09-6), ou celui qu'il aurait tiré.
 */
function installFusionChat(): ReturnType<typeof vi.fn> {
  chunkListeners.length = 0;
  const start: ReturnType<typeof vi.fn> = vi.fn(async (_messages: unknown[], opts?: StartOpts) => ({
    success: true,
    sessionId: (opts?.sessionId as string | undefined) ?? drawnByMain(start.mock.calls.length - 1),
  }));
  const unsub = (): void => undefined;
  const chat = {
    start,
    cancel: vi.fn(async () => ({ success: true })),
    onChunk: (cb: (env: ChunkEnvelope) => void) => {
      chunkListeners.push(cb);
      return () => {
        const i = chunkListeners.indexOf(cb);
        if (i >= 0) chunkListeners.splice(i, 1);
      };
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

/** L'identifiant que le main tire quand le renderer n'en donne pas : un par tour. */
const drawnByMain = (call: number): string => `tiré-par-le-main-${call}`;

/** L'identifiant du tour n° `call`, tel que le renderer l'a donné à `start` (ou que le main a tiré). */
function sessionOf(start: ReturnType<typeof vi.fn>, call = 0): string {
  const opts = (start.mock.calls[call] as [unknown[], StartOpts])[1];
  return (opts?.sessionId as string | undefined) ?? drawnByMain(call);
}

function cancelOf(): ReturnType<typeof vi.fn> {
  return (window as unknown as { electron: { fusion: { chat: { cancel: ReturnType<typeof vi.fn> } } } })
    .electron.fusion.chat.cancel;
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
    const start = installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'ollama', model: 'qwen3.5:35b' });
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    const s1 = sessionOf(start);
    act(() => {
      emit({ sessionId: s1, chunk: { delta: '', thinking: 'hmm' } });
      emit({ sessionId: s1, chunk: { delta: 'Réponse' } });
      emit({ sessionId: s1, chunk: { delta: '', done: true, finishReason: 'stop' } });
    });
    const last = useChatStore.getState().messages.at(-1);
    expect(last?.thinking).toBe('hmm');
    expect(last?.content).toBe('Réponse');
  });

  it('traduit le délai d’inactivité dépassé en message d’erreur localisé', async () => {
    const start = installFusionChat();
    useRAGQueryStore.getState().setParams({ provider: 'ollama', model: 'gemma3:4b', timeout: 300_000 });

    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    expect(chunkListeners).toHaveLength(1);
    act(() => {
      emit({
        sessionId: sessionOf(start),
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'timeout', message: 'message côté main' },
      });
    });
    // Traduit par l'instance i18n de l'app (le flux vit hors des composants, L09-6) : la phrase
    // localisée, avec le délai réglé, et non le message brut du main.
    expect(result.current.error).toBe(i18n.t('chat.timeout', { minutes: 5 }));
    expect(result.current.error).not.toBe('chat.timeout');
    expect(result.current.error).toContain('5');
    expect(result.current.isStreaming).toBe(false);
  });

  // L09-7 : chaque fournisseur nomme ses pannes par son préfixe. Seuls ceux d'Ollama étaient
  // habillés ; « invalid x-api-key » arrivait seul, sans dire que c'était le modèle qui refusait.
  it.each([
    ['anthropic_http_401', 'invalid x-api-key'],
    ['openai_compat_stream_error', 'server_error'],
    ['mistral_http_429', 'Requests rate limit exceeded'],
    ['gemini_http_400', 'API key not valid. Please pass a valid API key.'],
    ['embedded_generation_failed', 'context size exceeded'],
  ])('habille la panne %s comme une erreur du modèle', async (code, message) => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    act(() => {
      emit({
        sessionId: sessionOf(start),
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code, message },
      });
    });
    expect(result.current.error).toBe(i18n.t('chat.providerError', { message }));
    expect(result.current.error).not.toBe(message);
  });

  // Revue de L09-7 : ces causes ne viennent pas de l'API mais de ClioDeck, écrites par le main, qui
  // n'a pas la langue de l'interface. Insérées telles quelles, une interface en anglais lisait
  // « The model failed: Le flux s’est fermé avant la fin de la réponse. ».
  it.each([
    ['ollama_stream_incomplete', 'Le flux s’est fermé avant la fin de la réponse.', 'chat.streamIncomplete'],
    ['anthropic_stream_incomplete', 'Le flux s’est fermé avant la fin de la réponse.', 'chat.streamIncomplete'],
    ['stream_incomplete', 'LLM stream ended without a terminal chunk', 'chat.streamIncomplete'],
    ['ollama_http_200', 'Réponse sans corps', 'chat.emptyResponse'],
    ['gemini_http_200', 'Réponse sans corps', 'chat.emptyResponse'],
    ['anthropic_stream_error', '', 'chat.providerNoCause'],
    ['ollama_stream_error', '', 'chat.providerNoCause'],
    ['provider_error', 'Le fournisseur a interrompu la réponse sans donner de cause.', 'chat.providerNoCause'],
    // Plafond des tours d'outils (S06-1-4) : le moteur l'écrit en anglais, pour le journal.
    ['max_tool_turns', 'Tool-call limit reached (6 turns) without a final answer', 'chat.maxToolTurns'],
    // Question plus longue que la fenêtre du modèle embarqué (L08-4) : jamais coupée, refusée.
    [
      'embedded_prompt_too_long',
      "The question needs 2700 tokens, more than the 2663 that the embedded model's 4096-token context window leaves for the input.",
      'chat.embeddedPromptTooLong',
    ],
  ])('traduit par son code la panne %s, dont la cause vient de ClioDeck', async (code, message, key) => {
    await i18n.changeLanguage('en');
    try {
      const start = installFusionChat();
      const { result } = renderHook(() => useBrainstormChat());
      await act(async () => {
        await result.current.send('hello');
      });
      act(() => {
        emit({
          sessionId: sessionOf(start),
          chunk: { delta: '', done: true, finishReason: 'error' },
          error: { code, message },
        });
      });
      expect(i18n.t(key)).not.toBe(key);
      expect(result.current.error).toBe(i18n.t(key));
      if (message) expect(result.current.error).not.toContain(message);
    } finally {
      await i18n.changeLanguage('fr');
    }
  });

  // Un modèle pensant qui tombe en cours de raisonnement : la bulle garde ce qu'il a pensé, et
  // l'erreur s'y ajoute.
  it('le raisonnement reçu avant la panne reste dans la bulle', async () => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('bonjour');
    });
    const s1 = sessionOf(start);
    act(() => {
      emit({ sessionId: s1, chunk: { delta: '', thinking: 'Je cherche le préfet…' } });
      emit({
        sessionId: s1,
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'ollama_stream_error', message: 'model runner has unexpectedly stopped' },
      });
    });
    const last = useChatStore.getState().messages.at(-1);
    expect(last).toMatchObject({
      role: 'assistant',
      thinking: 'Je cherche le préfet…',
      finishReason: 'error',
      isError: true,
      pending: false,
    });
    expect(last?.error).toContain('model runner has unexpectedly stopped');
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
    const cancel = cancelOf();

    const { result } = renderHook(() => useBrainstormChat());
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('Qui était le préfet en 1934 ?');
    });
    // La bulle en attente est posée avant la réponse de chat.start (L09-6).
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['Qui était le préfet en 1934 ?', '']);
    const s1 = sessionOf(start);

    act(() => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    await act(async () => {
      answer({ success: true, sessionId: s1 });
      await sending;
    });
    act(() => {
      emit({ sessionId: s1, chunk: { delta: 'Le préfet était…' } });
      emit({ sessionId: s1, chunk: { delta: '', done: true, finishReason: 'cancelled' } });
    });

    expect(useChatStore.getState().messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(cancel).toHaveBeenCalledWith(s1);
  });

  // Le chat n'est pas vidé quand A reste à l'écran : l'ouverture de B échoue et A revient « stores
  // intacts », ou le même dossier est rouvert. La bulle, posée avant chat.start (L09-6), ne doit pas
  // tourner jusqu'à Stop.
  it.each([
    ['l’ouverture de B échoue et A revient', () => projectLifecycle.abortTransition()],
    ['le même projet est rouvert', () => projectLifecycle.enter('/projets/A')],
  ])('%s pendant chat.start : la bulle s’arrête, la session est annulée', async (_cas, settle) => {
    const start = installFusionChat();
    let answer!: (value: { success: boolean; sessionId?: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const cancel = cancelOf();

    const { result } = renderHook(() => useBrainstormChat());
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('Qui était le préfet en 1934 ?');
    });
    const s1 = sessionOf(start);
    act(() => {
      projectLifecycle.beginTransition();
      settle();
    });
    await act(async () => {
      answer({ success: true, sessionId: s1 });
      await sending;
    });
    act(() => emit({ sessionId: s1, chunk: { delta: 'Le préfet était…' } }));

    const [question, bubble] = useChatStore.getState().messages;
    expect(question.content).toBe('Qui était le préfet en 1934 ?');
    expect(bubble).toMatchObject({ role: 'assistant', content: '', pending: false, finishReason: 'cancelled' });
    expect(useChatStore.getState().pendingAssistantId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
    expect(cancel).toHaveBeenCalledWith(s1);
  });

  it('témoin : la clé absente a fini la bulle avant le retour de A, son erreur reste affichée', async () => {
    const start = installFusionChat();
    let answer!: (value: { success: boolean; sessionId?: string }) => void;
    start.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const { result } = renderHook(() => useBrainstormChat());
    let sending!: Promise<void>;
    act(() => {
      sending = result.current.send('Qui était le préfet en 1934 ?');
    });
    const s1 = sessionOf(start);
    act(() =>
      emit({
        sessionId: s1,
        chunk: { delta: '', done: true, finishReason: 'error' },
        error: { code: 'config_error', message: 'Clé d’API absente pour Claude.' },
      })
    );
    act(() => {
      projectLifecycle.beginTransition();
      projectLifecycle.abortTransition();
    });
    await act(async () => {
      answer({ success: true, sessionId: s1 });
      await sending;
    });

    expect(useChatStore.getState().messages[1]).toMatchObject({
      pending: false,
      finishReason: 'error',
      error: 'Clé d’API absente pour Claude.',
    });
    expect(result.current.isStreaming).toBe(false);
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
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      emit({ sessionId: sessionOf(start), chunk: { delta: 'Le préfet était…', done: true, finishReason: 'stop' } });
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
    const { result } = renderHook(() => useBrainstormChat());

    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });
    act(() => {
      emit({ sessionId: sessionOf(start, 0), chunk: { delta: 'Jean Chiappe.', done: true, finishReason: 'stop' } });
    });
    await act(async () => {
      await result.current.send('Et en 1936 ?');
    });
    act(() => {
      emit({
        sessionId: sessionOf(start, 1),
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
    const s1 = sessionOf(start);
    act(() => {
      emit({ sessionId: s1, chunk: { delta: 'Le préfet était' } });
      emit({
        sessionId: s1,
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

/**
 * Un tour appartient à sa session, du premier événement au dernier (L09-6). Le lien entre la
 * session et sa bulle vivait dans le composant, et ne se posait qu'à la réponse de `chat.start`.
 */
describe('useBrainstormChat — le tour appartient à sa session', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
    useChatStore.getState().setChatSettings({ sendBlockedReasons: undefined });
  });
  afterEach(() => {
    cleanup();
  });

  /** `chat.start` dont le main émet le chunk terminal avant de répondre, comme `pump` le fait. */
  function startEmitsBeforeAnswering(start: ReturnType<typeof vi.fn>, error: { code: string; message: string }): void {
    start.mockImplementationOnce(async (_messages: unknown[], opts?: StartOpts) => {
      const sessionId = (opts?.sessionId as string | undefined) ?? drawnByMain(start.mock.calls.length - 1);
      emit({ sessionId, chunk: { delta: '', done: true, finishReason: 'error' }, error });
      return { success: true, sessionId };
    });
  }

  it('clé d’API absente : l’erreur émise avant la réponse de chat.start s’affiche, et le tour finit (S16-1-20)', async () => {
    const start = installFusionChat();
    const message = 'Anthropic backend selected but no claudeAPIKey set in config.';
    startEmitsBeforeAnswering(start, { code: 'config_error', message });
    const { result } = renderHook(() => useBrainstormChat());

    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });

    expect(result.current.error).toBe(message);
    expect(result.current.isStreaming).toBe(false);
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({ role: 'assistant', pending: false });
  });

  it('envoi distant refusé : le refus émis avant la réponse de chat.start finit aussi la bulle', async () => {
    const start = installFusionChat();
    const message = 'Envoi vers Anthropic Claude refusé : aucun consentement.';
    startEmitsBeforeAnswering(start, { code: 'cloud_consent_required', message });
    const { result } = renderHook(() => useBrainstormChat());

    await act(async () => {
      await result.current.send('Qui était le préfet en 1934 ?');
    });

    expect(result.current.error).toBe(message);
    expect(result.current.isStreaming).toBe(false);
  });

  it('quitter l’onglet Chat et revenir : la réponse continue et le tour se termine (S16-1-0)', async () => {
    const start = installFusionChat();
    const first = renderHook(() => useBrainstormChat());
    await act(async () => {
      await first.result.current.send('Qui était le préfet en 1934 ?');
    });
    const s1 = sessionOf(start);
    act(() => emit({ sessionId: s1, chunk: { delta: 'Début' } }));

    // L'onglet Journal : le chat est démonté, puis remonté au retour.
    first.unmount();
    const second = renderHook(() => useBrainstormChat());
    act(() => {
      emit({ sessionId: s1, chunk: { delta: ', suite.' } });
      emit({ sessionId: s1, chunk: { delta: '', done: true, finishReason: 'stop' } });
    });

    expect(useChatStore.getState().messages.at(-1)).toMatchObject({ content: 'Début, suite.', pending: false });
    expect(second.result.current.isStreaming).toBe(false);
  });

  it('Effacer pendant la génération annule le tour côté main (S16-1-3)', async () => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Une longue question');
    });
    const s1 = sessionOf(start);
    act(() => emit({ sessionId: s1, chunk: { delta: 'Une réponse qui part mal' } }));

    act(() => result.current.reset());

    expect(cancelOf()).toHaveBeenCalledWith(s1);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
  });

  it('la fin du tour effacé, arrivée après l’envoi du suivant, ne termine pas celui-ci (S16-1-3)', async () => {
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Une longue question');
    });
    const s1 = sessionOf(start, 0);
    act(() => emit({ sessionId: s1, chunk: { delta: 'Une réponse qui part mal' } }));
    act(() => result.current.reset());
    await act(async () => {
      await result.current.send('Une autre question');
    });
    const s2 = sessionOf(start, 1);

    act(() => emit({ sessionId: s1, chunk: { delta: '', done: true, finishReason: 'stop' } }));

    expect(result.current.isStreaming).toBe(true);
    expect(useChatStore.getState().sessionId).toBe(s2);

    act(() => {
      emit({ sessionId: s2, chunk: { delta: 'La bonne réponse.' } });
      emit({ sessionId: s2, chunk: { delta: '', done: true, finishReason: 'stop' } });
    });
    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([
      'Une autre question',
      'La bonne réponse.',
    ]);
    expect(result.current.isStreaming).toBe(false);
  });

  it('session lancée dans A, puis B ouvert : sa suite et sa fin ne s’écrivent pas dans le chat de B', async () => {
    projectLifecycle.enter('/projets/A');
    const start = installFusionChat();
    const { result } = renderHook(() => useBrainstormChat());
    await act(async () => {
      await result.current.send('Question posée dans A');
    });
    const sA = sessionOf(start, 0);
    act(() => emit({ sessionId: sA, chunk: { delta: 'Début de réponse dans A' } }));

    act(() => {
      projectLifecycle.beginTransition();
      projectLifecycle.enter('/projets/B');
    });
    await act(async () => {
      await result.current.send('Question posée dans B');
    });
    const sB = sessionOf(start, 1);
    act(() => {
      emit({ sessionId: sA, chunk: { delta: ', suite de A' } });
      emit({ sessionId: sA, chunk: { delta: '', done: true, finishReason: 'cancelled' } });
    });

    expect(useChatStore.getState().messages.map((m) => m.content)).toEqual(['Question posée dans B', '']);
    expect(result.current.isStreaming).toBe(true);
    expect(useChatStore.getState().sessionId).toBe(sB);
  });
});
