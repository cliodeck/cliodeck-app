/**
 * Banc d'essai d'un tour de chat complet (L08-3) : `fusionChatService.start`
 * → `pump` → `runChatTurn` → fournisseur, et retour par `webContents.send`.
 *
 * Vrai service, vrai moteur, vrai délai d'inactivité, vrai registre des
 * opérations. Seuls sont simulés le registre de fournisseurs (un faux modèle
 * piloté par `bench.provider`), la configuration et la recherche — et
 * `webContents`, qui capture les envois. Les tests de tour à venir
 * s'ajoutent ici plutôt que de réécrire un banc chacun (amendement A7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
} from '../../../../backend/core/llm/providers/base.js';

type FakeChat = (messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<ChatChunk>;

const bench = vi.hoisted(() => ({
  provider: null as FakeChat | null,
  /** Message levé par la construction du registre (configuration invalide). */
  configError: null as string | null,
  seenOpts: [] as ChatOptions[],
}));

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => {
      if (bench.configError) throw new Error(bench.configError);
      return {
        getLLM: () => ({
          id: 'fake', name: 'Fake', model: 'fake-model',
          capabilities: { chat: true, streaming: true, tools: false },
          getStatus: () => ({ state: 'ready' }),
          chat: (messages: ChatMessage[], opts: ChatOptions) => {
            bench.seenOpts.push(opts);
            if (!bench.provider) throw new Error('bench.provider non défini');
            return bench.provider(messages, opts);
          },
        }),
        dispose: async () => undefined,
      };
    },
  };
});

import { fusionChatService, type ChatStreamEnvelope } from '../fusion-chat-service.js';
import { operations, type CancellableOperation } from '../cancellable-operation.js';
import { configManager } from '../config-manager.js';
import { projectManager } from '../project-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';

interface Sent { channel: string; payload: unknown }

/** Un faux `WebContents` qui garde tout ce que le service lui envoie. */
function captureWebContents(): { webContents: WebContents; sent: Sent[] } {
  const sent: Sent[] = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
  } as unknown as WebContents;
  return { webContents, sent };
}

const chunks = (sent: Sent[]): ChatStreamEnvelope[] =>
  sent.filter((e) => e.channel === 'fusion:chat:chunk').map((e) => e.payload as ChatStreamEnvelope);

const terminal = (sent: Sent[]): ChatStreamEnvelope | undefined => chunks(sent).find((e) => e.chunk.done);

/** Comme un vrai fournisseur : attend le signal, puis rend un `cancelled` terminal. */
async function* waitForAbort(_messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatChunk> {
  const signal = opts.signal;
  if (!signal) throw new Error('aucun signal transmis au fournisseur');
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  yield { delta: '', done: true, finishReason: 'cancelled' };
}

function startTurn(opts?: { timeoutMs?: number }): { sessionId: string; sent: Sent[] } {
  const { webContents, sent } = captureWebContents();
  const sessionId = fusionChatService.start({
    webContents,
    messages: [{ role: 'user', content: 'question' }],
    systemPrompt: { language: 'fr' },
    opts,
  });
  return { sessionId, sent };
}

const WAIT = { timeout: 5_000 };

beforeEach(() => {
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, systemPromptLanguage: 'fr' } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue(null);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
  vi.spyOn(retrievalService, 'describeDocuments').mockReturnValue([]);
  vi.spyOn(retrievalService, 'searchWithStats').mockResolvedValue({
    hits: [], manuscriptHits: [], readingNoteHits: [], outcomes: [], securityEvents: [],
    stats: { search: { query: 'question', totalResults: 0, searchDurationMs: 1, cacheHit: false, sourceType: 'both', documents: [], corpora: [] }, timing: { searchMs: 1 } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  bench.provider = null;
  bench.configError = null;
  bench.seenOpts.length = 0;
});

describe('banc du pump de chat', () => {
  it('start, deltas puis done, dans cet ordre, et le registre se vide', async () => {
    bench.provider = async function* () {
      yield { delta: 'Bon', done: false };
      yield { delta: 'jour', done: false };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    const stream = chunks(sent);
    expect(stream.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(stream.map((e) => [e.chunk.delta, e.chunk.done])).toEqual([
      ['Bon', false],
      ['jour', false],
      ['', true],
    ]);
    expect(stream[2].chunk.finishReason).toBe('stop');
    expect(stream[2].error).toBeUndefined();
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });

  it('cancel : le fournisseur voit le signal coupé, le chunk terminal est cancelled, le registre se vide', async () => {
    bench.provider = waitForAbort;
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(bench.seenOpts).toHaveLength(1), WAIT);
    // Le tour est inscrit au registre pendant qu'il tourne.
    const op = operations.find(sessionId);
    expect(op?.kind).toBe('chat');
    expect(fusionChatService.cancel(sessionId)).toBe(true);
    expect(bench.seenOpts[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.chunk.finishReason).toBe('cancelled');
    expect(terminal(sent)?.error).toBeUndefined();
    expect(op?.cancelReason).toBe('user');
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
    expect(fusionChatService.cancel(sessionId)).toBe(false);
  });

  it("cancel d'une session ne coupe pas l'autre", async () => {
    bench.provider = waitForAbort;
    const a = startTurn();
    const b = startTurn();
    await vi.waitFor(() => expect(bench.seenOpts).toHaveLength(2), WAIT);
    fusionChatService.cancel(a.sessionId);
    await vi.waitFor(() => expect(terminal(a.sent)).toBeDefined(), WAIT);
    expect(terminal(b.sent)).toBeUndefined();
    expect(operations.find(b.sessionId)?.state).toBe('running');
    fusionChatService.cancel(b.sessionId);
    await vi.waitFor(() => expect(terminal(b.sent)?.chunk.finishReason).toBe('cancelled'), WAIT);
  });

  it("délai d'inactivité : enveloppe d'erreur timeout, pas un cancelled", async () => {
    // L'opération se lit au moment de l'appel : à 30 ms, le tour peut être
    // fini avant le premier passage de `vi.waitFor`.
    const seen: { sessionId: string; op: CancellableOperation | null } = { sessionId: '', op: null };
    bench.provider = (messages, opts) => {
      seen.op = operations.find(seen.sessionId);
      return waitForAbort(messages, opts);
    };
    const { sessionId, sent } = startTurn({ timeoutMs: 30 });
    // `start` rend la main avant que le pump n'atteigne le fournisseur.
    seen.sessionId = sessionId;
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    const end = terminal(sent);
    expect(end?.chunk.finishReason).toBe('error');
    expect(end?.error?.code).toBe('timeout');
    expect(bench.seenOpts[0].signal?.aborted).toBe(true);
    expect(seen.op?.kind).toBe('chat');
    expect(seen.op?.cancelReason).toBe('timeout');
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });

  it('configuration invalide : config_error, sans appel au fournisseur', async () => {
    bench.configError = 'clé API absente';
    bench.provider = waitForAbort;
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.error).toEqual({ code: 'config_error', message: 'clé API absente' });
    expect(bench.seenOpts).toHaveLength(0);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });
});
