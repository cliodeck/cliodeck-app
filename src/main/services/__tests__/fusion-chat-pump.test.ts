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
  LLMProvider,
} from '../../../../backend/core/llm/providers/base.js';

type FakeChat = (messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<ChatChunk>;

const bench = vi.hoisted(() => ({
  provider: null as FakeChat | null,
  /** Message levé par la construction du registre (configuration invalide). */
  configError: null as string | null,
  seenOpts: [] as ChatOptions[],
  seenMessages: [] as ChatMessage[][],
  /** Fenêtre ouverte : sans elle, le main n'a personne à qui demander (refus). */
  window: null as object | null,
  /** Réponse au dialogue natif de consentement : 1 accepte, 0 annule. */
  dialogResponse: 0,
  dialogCalls: [] as Array<{ message: string; detail: string }>,
  /** Le faux modèle sait appeler des outils : le catalogue MCP part avec le tour. */
  tools: false,
  /** Le faux modèle passe par le décorateur du journal d'usage, comme les vrais. */
  instrumented: false,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => bench.window,
    getAllWindows: () => (bench.window ? [bench.window] : []),
  },
  dialog: {
    showMessageBox: async (_win: unknown, options: { message: string; detail: string }) => {
      bench.dialogCalls.push({ message: options.message, detail: options.detail });
      return { response: bench.dialogResponse };
    },
  },
}));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  const { instrumentLLM } = await import('../../../../backend/core/llm/providers/instrument.js');
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => {
      if (bench.configError) throw new Error(bench.configError);
      const llm = {
        id: 'fake', name: 'Fake', model: 'fake-model',
        capabilities: { chat: true, streaming: true, tools: bench.tools },
        getStatus: () => ({ state: 'ready' }),
        chat: (messages: ChatMessage[], opts: ChatOptions) => {
          bench.seenOpts.push(opts);
          bench.seenMessages.push(messages);
          if (!bench.provider) throw new Error('bench.provider non défini');
          return bench.provider(messages, opts);
        },
      };
      return {
        getLLM: () =>
          bench.instrumented
            ? instrumentLLM(llm as unknown as LLMProvider, 'ollama', 'http://localhost:11434')
            : llm,
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
import type { ReadingNoteMappedSearchResult, RetrievalSearchWithStatsResult } from '../retrieval-service.js';
import type { RAGExplanation } from '../../../../backend/types/chat-source.js';
import { cloudConsent } from '../../../../backend/security/cloud-consent.js';
import { historyService } from '../history-service.js';
import { mcpClientsService } from '../mcp-clients-service.js';
import { HistoryManager } from '../../../../backend/core/history/HistoryManager.js';
import { getJournalContext, setInferenceSink } from '../../../../backend/core/usage-journal/context.js';
import type { RecordInferenceInput } from '../../../../backend/core/usage-journal/types.js';
import { OperationBusyError } from '../cancellable-operation.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function startTurn(opts?: { timeoutMs?: number }, sessionId?: string): { sessionId: string; sent: Sent[] } {
  const { webContents, sent } = captureWebContents();
  const started = fusionChatService.start({
    webContents,
    messages: [{ role: 'user', content: 'question' }],
    systemPrompt: { language: 'fr' },
    opts,
    sessionId,
  });
  return { sessionId: started, sent };
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
  bench.seenMessages.length = 0;
  bench.window = null;
  bench.dialogResponse = 0;
  bench.dialogCalls.length = 0;
  bench.tools = false;
  bench.instrumented = false;
  setInferenceSink(undefined);
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

  /**
   * Le renderer choisit l'identifiant et lie son message avant l'appel (L09-6) : tout ce que le tour
   * émet le porte, y compris l'erreur de configuration émise avant que `start` ne rende la main
   * (S16-1-20). Témoin du contrat sur lequel repose le correctif, côté renderer.
   */
  it('l’identifiant donné par l’appelant porte tout le tour, config_error compris', async () => {
    const SESSION = '5d1f0c2a-8e4b-4c7d-9a6f-3b2e1d0c9f8a';
    bench.configError = 'clé API absente';
    const { sessionId, sent } = startTurn(undefined, SESSION);
    expect(sessionId).toBe(SESSION);
    // Émis pendant `start`, avant toute attente : c'est ce qui le faisait perdre au renderer.
    expect(terminal(sent)?.sessionId).toBe(SESSION);
    expect(terminal(sent)?.error?.code).toBe('config_error');
    await vi.waitFor(() => expect(operations.find(SESSION)).toBeNull(), WAIT);
  });

  it('un identifiant déjà en cours est refusé, et le tour qui le porte continue', async () => {
    const SESSION = '7a3e9b1c-2d4f-4e6a-8b0c-1f2e3d4c5b6a';
    bench.provider = waitForAbort;
    const first = startTurn(undefined, SESSION);
    await vi.waitFor(() => expect(bench.seenOpts).toHaveLength(1), WAIT);

    expect(() => startTurn(undefined, SESSION)).toThrow(OperationBusyError);

    expect(operations.find(SESSION)?.state).toBe('running');
    expect(bench.seenOpts[0].signal?.aborted).toBe(false);
    fusionChatService.cancel(SESSION);
    await vi.waitFor(() => expect(terminal(first.sent)?.chunk.finishReason).toBe('cancelled'), WAIT);
    await vi.waitFor(() => expect(operations.find(SESSION)).toBeNull(), WAIT);
  });

  /**
   * « Effacer » annule désormais le tour (S16-1-3) : le journal d'usage n'inscrit que ce que le
   * modèle a produit avant l'annulation, pas la réponse entière que le tour effacé générait jusqu'ici
   * en arrière-plan.
   */
  it('annuler arrête le compte du journal d’usage à ce qui a été produit', async () => {
    const recorded: RecordInferenceInput[] = [];
    setInferenceSink((e) => recorded.push(e));
    bench.instrumented = true;
    const REST = 'suite de la réponse '.repeat(200);
    bench.provider = async function* (messages, opts) {
      yield { delta: 'Début', done: false };
      if (!opts.signal?.aborted) {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (!opts.signal?.aborted) yield { delta: REST, done: false };
      yield* waitForAbort(messages, opts);
    };
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(chunks(sent).some((e) => e.chunk.delta === 'Début')).toBe(true), WAIT);

    fusionChatService.cancel(sessionId);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);

    const completions = recorded.filter((e) => e.kind === 'completion');
    expect(completions).toHaveLength(1);
    // « Début » : 5 caractères, 2 jetons estimés ; la réponse entière en ferait plus de mille.
    expect(completions[0].completionTokens).toBe(2);
    expect(chunks(sent).map((e) => e.chunk.delta).join('')).toBe('Début');
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

/**
 * Le terminal porte le modèle du tour (S16-1-23) : le renderer en signe les brouillons et les
 * propositions, que le journal d'usage reçoit ensuite. Il les signait d'un modèle deviné dans les
 * réglages (le modèle Ollama du panneau, même en génération embarquée).
 */
describe('le terminal porte le modèle du tour (S16-1-23)', () => {
  it('fin ordinaire, annulation, délai d’inactivité, panne du fournisseur : le modèle qui a servi', async () => {
    bench.provider = async function* () {
      yield { delta: 'Réponse.', done: false };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    const done = startTurn();
    await vi.waitFor(() => expect(terminal(done.sent)).toBeDefined(), WAIT);

    bench.provider = waitForAbort;
    const stopped = startTurn();
    await vi.waitFor(() => expect(bench.seenOpts).toHaveLength(2), WAIT);
    fusionChatService.cancel(stopped.sessionId);
    await vi.waitFor(() => expect(terminal(stopped.sent)).toBeDefined(), WAIT);

    const idle = startTurn({ timeoutMs: 30 });
    await vi.waitFor(() => expect(terminal(idle.sent)).toBeDefined(), WAIT);

    bench.provider = async function* () {
      yield { delta: '', done: true, finishReason: 'error' };
    };
    const failed = startTurn();
    await vi.waitFor(() => expect(terminal(failed.sent)).toBeDefined(), WAIT);

    expect(
      [done, stopped, idle, failed].map(({ sent }) => [terminal(sent)?.chunk.finishReason, terminal(sent)?.model])
    ).toEqual([
      ['stop', 'fake-model'],
      ['cancelled', 'fake-model'],
      ['error', 'fake-model'],
      ['error', 'fake-model'],
    ]);
    // Les morceaux de la réponse ne le portent pas : seul le terminal le dit.
    expect(chunks(done.sent).filter((e) => !e.chunk.done).every((e) => e.model === undefined)).toBe(true);
  });

  it('configuration invalide : aucun modèle n’a servi, le terminal n’en nomme aucun', async () => {
    bench.configError = 'clé API absente';
    const { sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.model).toBeUndefined();
  });
});

describe('consentement distant : modèle Ollama hébergé (L04-1)', () => {
  const NOTE = 'La longue durée écrase l’événement.';
  const noteHit: ReadingNoteMappedSearchResult = {
    chunk: { id: 'n-0', content: NOTE, documentId: 'zotero:ABCD1234', chunkIndex: 0 },
    document: { id: 'zotero:ABCD1234', title: 'La Méditerranée', author: null, bibtexKey: 'Braudel_1949' },
    source: {
      kind: 'reading-note',
      relativePath: 'reading-notes/Braudel_1949.md',
      noteId: 'zotero:ABCD1234',
      citekey: 'Braudel_1949',
      zoteroKey: 'ABCD1234',
      tags: [],
      line: 9,
    },
    similarity: 0.7,
    sourceType: 'readingNotes',
  };
  let project = '';

  function setLLM(ollamaURL: string, ollamaChatModel: string): void {
    vi.mocked(configManager.getLLMConfig).mockReturnValue({ backend: 'ollama', ollamaURL, ollamaChatModel } as ReturnType<typeof configManager.getLLMConfig>);
  }

  /** Une question de rappel sur les notes, avec le modèle du panneau. */
  function askNotes(model?: string): { sent: Sent[] } {
    const { webContents, sent } = captureWebContents();
    fusionChatService.start({
      webContents,
      messages: [{ role: 'user', content: 'Que disent mes notes sur Braudel ?' }],
      systemPrompt: { language: 'fr' },
      opts: model ? { model } : undefined,
    });
    return { sent };
  }

  const searched = (): { includeReadingNotes?: boolean } =>
    vi.mocked(retrievalService.searchWithStats).mock.calls[0][0] as { includeReadingNotes?: boolean };
  const prompted = (): string => bench.seenMessages.flat().map((m) => m.content).join('\n');

  beforeEach(() => {
    cloudConsent.revoke();
    bench.window = {};
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-cloud-model-'));
    vi.mocked(projectManager.getCurrentProjectPath).mockReturnValue(project);
    vi.mocked(readingNotesIndexService.isEnabled).mockReturnValue(true);
    vi.mocked(retrievalService.searchWithStats).mockImplementation(async (opts) => ({
      hits: [], manuscriptHits: [], outcomes: [], securityEvents: [],
      readingNoteHits: opts.includeReadingNotes ? [noteHit] : [],
      stats: { search: { query: 'q', totalResults: 0, searchDurationMs: 1, cacheHit: false, sourceType: 'both', documents: [], corpora: [] }, timing: { searchMs: 1 } },
    }));
    bench.provider = async function* () {
      yield { delta: 'ok', done: true, finishReason: 'stop' };
    };
  });

  afterEach(() => {
    cloudConsent.revoke();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('témoin local : llama3.2 en loopback, aucun dialogue, les notes entrent', async () => {
    setLLM('http://127.0.0.1:11434', 'llama3.2');
    const { sent } = askNotes();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(bench.dialogCalls).toHaveLength(0);
    expect(searched().includeReadingNotes).toBe(true);
    expect(prompted()).toContain(NOTE);
  });

  it('modèle -cloud du panneau : dialogue une fois, notes retenues faute de consentement', async () => {
    setLLM('http://127.0.0.1:11434', 'llama3.2');
    bench.dialogResponse = 1;
    const { sent } = askNotes('gpt-oss:120b-cloud');
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.error).toBeUndefined();
    expect(bench.dialogCalls).toHaveLength(1);
    expect(bench.dialogCalls[0].message).toContain('ollama.com');
    expect(searched().includeReadingNotes).toBe(false);
    expect(prompted()).not.toContain(NOTE);
  });

  it('modèle :cloud des réglages, dialogue refusé : le fournisseur n’est jamais appelé', async () => {
    setLLM('http://127.0.0.1:11434', 'qwen3.5:cloud');
    const { sent } = askNotes();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(bench.dialogCalls).toHaveLength(1);
    expect(terminal(sent)?.error?.code).toBe('cloud_consent_required');
    expect(bench.seenOpts).toHaveLength(0);
  });

  it('témoin distant : Ollama sur un autre hôte, dialogue et notes retenues', async () => {
    setLLM('http://gpu.labo.example:11434', 'llama3.2');
    bench.dialogResponse = 1;
    const { sent } = askNotes();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(bench.dialogCalls).toHaveLength(1);
    expect(searched().includeReadingNotes).toBe(false);
    expect(prompted()).not.toContain(NOTE);
  });
});

/**
 * Un tour s'écrit dans le projet qui l'a lancé (L03-6, décision Q11). Ouvrir B pendant une
 * génération de A annule le tour ; sa réponse partielle va au journal de recherche de A, encore
 * ouvert pendant le drain des opérations (`project-services.ts`). A déjà fermé (drain dépassé) :
 * rien ne s'écrit nulle part, le journal de B n'étant jamais celui du tour.
 *
 * Vrais journaux de recherche (SQLite) sur deux projets temporaires, vrai registre des opérations,
 * vrai drain : la bascule est celle de la séquence, réduite aux services en jeu.
 */
describe('bascule de projet pendant un tour (L03-6)', () => {
  let A = '';
  let B = '';

  beforeEach(async () => {
    A = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tour-A-'));
    B = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tour-B-'));
    vi.mocked(projectManager.getCurrentProjectPath).mockReturnValue(A);
    await historyService.init(A);
  });

  afterEach(() => {
    historyService.close();
    fs.rmSync(A, { recursive: true, force: true });
    fs.rmSync(B, { recursive: true, force: true });
  });

  /**
   * La fermeture de A puis l'ouverture de B, pour ce qui compte ici (project-services.ts) : les
   * opérations du projet s'annulent, la séquence attend leur fin au plus `drainMs`, puis ferme le
   * journal de A et ouvre celui de B. Vrai si le drain a fini à temps.
   */
  async function openB(drainMs: number): Promise<boolean> {
    operations.cancelScope('project', 'project-closed');
    const drained = await operations.drain('project', drainMs);
    historyService.close();
    vi.mocked(projectManager.getCurrentProjectPath).mockReturnValue(B);
    await historyService.init(B);
    return drained;
  }

  /**
   * Les messages du journal de recherche d'un projet, lus par une connexion à part. Triés : la
   * question et la réponse s'écrivent dans la même milliseconde, et le journal les rend par date.
   */
  function exchanges(project: string): Array<[string, string]> {
    const reader = new HistoryManager(project);
    try {
      return reader
        .getAllChatMessages()
        .map((m): [string, string] => [m.role, m.content])
        .sort(([a], [b]) => (a === b ? 0 : a === 'user' ? -1 : 1));
    } finally {
      reader.close();
    }
  }

  const deltas = (sent: Sent[]): string => chunks(sent).map((e) => e.chunk.delta).join('');

  it('le tour est annulé, et sa réponse partielle va au journal de A, rien à celui de B (Q11)', async () => {
    bench.provider = async function* (messages, opts) {
      yield { delta: 'Réponse ', done: false };
      yield { delta: 'partielle', done: false };
      yield* waitForAbort(messages, opts);
    };
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(deltas(sent)).toBe('Réponse partielle'), WAIT);

    expect(await openB(5_000)).toBe(true);

    expect(bench.seenOpts[0].signal?.aborted).toBe(true);
    expect(terminal(sent)?.chunk.finishReason).toBe('cancelled');
    expect(operations.find(sessionId)).toBeNull();
    expect(exchanges(A)).toEqual([
      ['user', 'question'],
      ['assistant', 'Réponse partielle'],
    ]);
    expect(exchanges(B)).toEqual([]);
  });

  it('le journal de A déjà fermé quand le tour finit (drain dépassé) : rien nulle part, et un avertissement', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Un modèle sourd au signal : le tour survit au drain.
    bench.provider = async function* () {
      yield { delta: 'Réponse ', done: false };
      await released;
      yield { delta: 'tardive', done: false };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(deltas(sent)).toBe('Réponse '), WAIT);

    expect(await openB(20)).toBe(false);
    release();
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);

    expect(exchanges(B)).toEqual([]);
    expect(exchanges(A)).toEqual([]);
    expect(warn.mock.calls.flat().map(String).join('\n')).toContain(A);
  });

  /** Un serveur MCP prêt, qui offre un outil ; rend l'espion de ses appels. */
  function offerTool() {
    bench.tools = true;
    vi.spyOn(mcpClientsService, 'list').mockReturnValue([
      {
        name: 'srv',
        state: 'ready',
        generation: 1,
        tools: [{ name: 'lookup', description: 'cherche', inputSchema: { type: 'object', properties: {} } }],
      },
    ]);
    return vi.spyOn(mcpClientsService, 'callTool').mockResolvedValue({ ok: true, result: 'réponse du serveur' });
  }

  /** Le modèle demande l'outil ; `between` tombe entre la demande et la fin de son message. */
  function askForTool(between: () => void): void {
    let call = 0;
    bench.provider = async function* (_messages, opts) {
      call += 1;
      if (call === 1) {
        yield { delta: '', done: false, toolCall: { id: 't1', name: 'srv__lookup', arguments: '{}' } };
        between();
        yield { delta: '', done: true, finishReason: 'tool_call' };
        return;
      }
      yield { delta: '', done: true, finishReason: opts.signal?.aborted ? 'cancelled' : 'stop' };
    };
  }

  const toolDone = (sent: Sent[]) =>
    sent
      .filter((e) => e.channel === 'fusion:chat:tool-call')
      .map((e) => e.payload as { status: string; ok?: boolean; errorMessage?: string })
      .find((p) => p.status === 'done');

  it('un appel d’outil après la bascule rend project_changed, sans atteindre les clients MCP', async () => {
    const callTool = offerTool();
    askForTool(() => operations.cancelScope('project', 'project-closed'));

    const { sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);

    expect(callTool).not.toHaveBeenCalled();
    expect(toolDone(sent)).toMatchObject({ ok: false });
    expect(toolDone(sent)?.errorMessage).toBeTruthy();
  });

  it('témoin : sans bascule, l’appel d’outil part au client MCP', async () => {
    const callTool = offerTool();
    askForTool(() => undefined);

    const { sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);

    expect(callTool).toHaveBeenCalledWith('srv', 'lookup', {});
    expect(toolDone(sent)).toMatchObject({ ok: true });
  });

  it('le fournisseur appelé par le tour voit la racine du projet du tour (journal d’usage)', async () => {
    const seen: Array<string | undefined> = [];
    bench.provider = async function* () {
      seen.push(getJournalContext()?.workspaceRoot);
      yield { delta: 'ok', done: false };
      seen.push(getJournalContext()?.workspaceRoot);
      yield { delta: '', done: true, finishReason: 'stop' };
    };

    const { sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);

    expect(seen).toEqual([A, A]);
  });
});

/**
 * La recherche en panne (S04-2-1). Ollama arrêté, la bibliographie et le coffre échouent et Tropy,
 * sans projet lié, ne rend rien : l'historien voyait Claude répondre de culture générale, ou conclure
 * que l'information « est absente des sources ». L'explication « échec » existe (#212) ; la consigne
 * au modèle doit dire que la recherche a échoué, lui demander de le dire, et ne pas varier selon que
 * la recherche a levé ou que chaque corpus a échoué de son côté. « Arrêter » pendant la recherche
 * n'est pas une panne (J9).
 */
describe('recherche en échec : le modèle et l’écran le disent (S04-2-1)', () => {
  let project = '';

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-recherche-en-panne-'));
    vi.mocked(projectManager.getCurrentProjectPath).mockReturnValue(project);
    bench.provider = async function* () {
      yield { delta: 'réponse', done: false };
      yield { delta: '', done: true, finishReason: 'stop' };
    };
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  type Corpus = 'secondary' | 'primary' | 'vault' | 'manuscript';
  const corpus = (source: Corpus, ok: boolean, hitCount = 0) =>
    ({ source, attempted: true, ok, hitCount, selectedCount: hitCount });
  const withCorpora = (
    corpora: Array<ReturnType<typeof corpus>>,
    hits: RetrievalSearchWithStatsResult['hits'] = []
  ): RetrievalSearchWithStatsResult => ({
    hits, manuscriptHits: [], readingNoteHits: [], outcomes: [], securityEvents: [],
    stats: { search: { query: 'question', totalResults: hits.length, searchDurationMs: 1, cacheHit: false, sourceType: 'both', documents: [], corpora }, timing: { searchMs: 1 } },
  });
  const ARCHIVE = 'Rapport du commissaire central sur la grève des dockers, 1907.';
  const archiveHit: RetrievalSearchWithStatsResult['hits'][number] = {
    chunk: { id: 'p-0', content: ARCHIVE, documentId: 'src-10', chunkIndex: 0 },
    document: { id: 'src-10', title: 'Rapport du commissaire central', author: undefined, bibtexKey: null },
    source: undefined,
    similarity: 0.6,
    sourceType: 'primary',
  };

  /** Les messages système reçus par le modèle au dernier appel. */
  const systemText = (): string =>
    (bench.seenMessages.at(-1) ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n').trim();
  const explanationOf = (sent: Sent[]): RAGExplanation | undefined =>
    (sent.find((e) => e.channel === 'fusion:chat:explanation')?.payload as { explanation: RAGExplanation } | undefined)
      ?.explanation;

  async function turn(): Promise<Sent[]> {
    const { sent } = startTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    return sent;
  }

  // Deux formes d'une recherche où rien n'a répondu. La première est celle de l'app quand Ollama est
  // arrêté et qu'aucun projet Tropy n'est lié : Tropy rend 0 sans rien chercher (E2), tous les corpus
  // qui avaient de quoi chercher tombent. La seconde, avec un Tropy lié et indexé, tombe en entier.
  it.each([
    {
      shape: 'Ollama arrêté, sans Tropy lié : archives à 0, tout le reste en échec',
      corpora: [corpus('secondary', false), corpus('primary', true), corpus('vault', false), corpus('manuscript', false)],
    },
    {
      shape: 'Tropy lié et indexé : tous les corpus en échec',
      corpora: [corpus('secondary', false), corpus('primary', false), corpus('vault', false)],
    },
  ])('$shape : explication « failed », et la consigne d’une recherche qui a levé', async ({ corpora }) => {
    vi.mocked(retrievalService.searchWithStats).mockResolvedValueOnce(withCorpora(corpora));
    const failed = await turn();
    expect(terminal(failed)?.error).toBeUndefined();
    expect(explanationOf(failed)?.search.retrievalStatus).toBe('failed');
    // La ligne « Par corpus » garde le détail : des archives sans projet lié restent à 0, pas en échec.
    expect(explanationOf(failed)?.search.corpora).toEqual(corpora);
    const failedNote = systemText();

    vi.mocked(retrievalService.searchWithStats).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const thrown = await turn();
    expect(terminal(thrown)?.error).toBeUndefined();
    expect(explanationOf(thrown)?.search.retrievalStatus).toBe('failed');

    expect(bench.seenOpts).toHaveLength(2);
    expect(failedNote).toBe(systemText());
    expect(failedNote).toMatch(/Dis à l['’]utilisateur/);
    expect(failedNote).toMatch(/ne conclus pas/);
    expect(failedNote).not.toMatch(/Certaines recherches/);
  });

  it('une partie des corpus en échec, un autre a répondu : panne partielle, à dire sans conclure à une absence', async () => {
    vi.mocked(retrievalService.searchWithStats).mockResolvedValueOnce(
      withCorpora([corpus('secondary', false), corpus('primary', true, 1)], [archiveHit])
    );
    const sent = await turn();
    expect(explanationOf(sent)?.search.retrievalStatus).toBe('partial');
    expect(systemText()).toContain(ARCHIVE);
    expect(systemText()).toMatch(/Certaines recherches dans les sources ont échoué/);
    expect(systemText()).toMatch(/Dis à l['’]utilisateur/);
    expect(systemText()).toMatch(/ne conclus pas/);
    // L'extrait des archives est là : ni « aucun extrait », ni la consigne d'une recherche sans réponse.
    expect(systemText()).not.toMatch(/Aucun extrait n['’]a été/);
    expect(systemText()).not.toMatch(/La recherche dans les sources a échoué/);
  });

  it('témoin J9 : « Arrêter » pendant la recherche ne donne ni consigne, ni échec affiché, ni appel au modèle', async () => {
    let searching = false;
    vi.mocked(retrievalService.searchWithStats).mockImplementationOnce(
      (q) =>
        new Promise((_resolve, reject) => {
          searching = true;
          const signal = q.signal;
          if (!signal) return reject(new Error('la recherche n’a pas reçu le signal du tour'));
          // Comme la recherche réelle : arrêtée, elle rejette par la raison du signal.
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const { sessionId, sent } = startTurn();
    await vi.waitFor(() => expect(searching).toBe(true), WAIT);
    expect(fusionChatService.cancel(sessionId)).toBe(true);
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);

    expect(terminal(sent)?.chunk.finishReason).toBe('cancelled');
    expect(terminal(sent)?.error).toBeUndefined();
    expect(explanationOf(sent)).toBeUndefined();
    expect(bench.seenOpts).toHaveLength(0);
  });
});

/**
 * Le résumé du compacteur dans un vrai tour (S06-1-18). Il partait avec `{ temperature: 0 }` seul :
 * sans la fenêtre `num_ctx` du tour (Ollama tronquait la conversation à résumer à sa fenêtre par
 * défaut), sans `think: false`, sans le signal du tour (« Arrêter » et le délai d'inactivité ne
 * l'arrêtaient pas), et le délai d'inactivité ne le voyait pas avancer.
 */
describe('résumé du compacteur dans le tour (S06-1-18)', () => {
  const isSummaryCall = (messages: ChatMessage[]): boolean =>
    messages.some((m) => m.content.startsWith('You are compressing'));

  async function* answer(): AsyncIterable<ChatChunk> {
    yield { delta: 'Réponse.', done: false };
    yield { delta: '', done: true, finishReason: 'stop' };
  }

  /** Six échanges de 1 200 caractères par message : bien au-delà de 70 % de 4 096 jetons. */
  function startLongTurn(opts: { timeoutMs?: number } = {}): { sessionId: string; sent: Sent[] } {
    const messages: ChatMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push({ role: 'user', content: `Q${i} ${'x'.repeat(1200)}` });
      messages.push({ role: 'assistant', content: `R${i} ${'y'.repeat(1200)}` });
    }
    messages.push({ role: 'user', content: 'Et le préfet Chiappe ?' });
    const { webContents, sent } = captureWebContents();
    const sessionId = fusionChatService.start({
      webContents,
      messages,
      systemPrompt: { language: 'fr' },
      opts: { numCtx: 4096, ...opts },
    });
    return { sessionId, sent };
  }

  beforeEach(() => {
    // Comme les vrais fournisseurs, enveloppés par le journal d'usage : `complete()` passe par `chat()`.
    bench.instrumented = true;
  });

  it('le résumé part avec la fenêtre du tour, sans raisonnement, sous le signal du tour', async () => {
    bench.provider = async function* (messages) {
      if (isSummaryCall(messages)) {
        yield { delta: 'Résumé fidèle.', done: false };
        yield { delta: '', done: true, finishReason: 'stop' };
        return;
      }
      yield* answer();
    };
    const { sessionId, sent } = startLongTurn();
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.chunk.finishReason).toBe('stop');
    expect(bench.seenMessages.map(isSummaryCall)).toEqual([true, false]);
    expect(bench.seenOpts[0]).toMatchObject({ temperature: 0, numCtx: 4096, think: false });
    expect(bench.seenOpts[0].signal).toBeDefined();
    expect(bench.seenOpts[0].signal).toBe(bench.seenOpts[1].signal);
    expect(bench.seenMessages[1].some((m) => m.content.includes('Résumé fidèle.'))).toBe(true);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });

  // Le résumé passe par le fournisseur du tour, enveloppé par le journal d'usage. « Arrêter » pendant
  // le résumé l'inscrivait « ok », comme une réponse rendue (L09-16).
  it('« Arrêter » pendant le résumé : le résumé s’inscrit « cancelled » au journal d’usage, et rien d’autre', async () => {
    const recorded: RecordInferenceInput[] = [];
    setInferenceSink((e) => recorded.push(e));
    bench.provider = (messages, opts) => (isSummaryCall(messages) ? waitForAbort(messages, opts) : answer());
    const { sessionId, sent } = startLongTurn();
    await vi.waitFor(() => expect(bench.seenMessages).toHaveLength(1), WAIT);

    fusionChatService.cancel(sessionId);
    await vi.waitFor(() => expect(terminal(sent)?.chunk.finishReason).toBe('cancelled'), WAIT);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);

    expect(bench.seenMessages.map(isSummaryCall)).toEqual([true]);
    expect(recorded.map((e) => [e.kind, e.status])).toEqual([['completion', 'cancelled']]);
  });

  it("délai d'inactivité : un résumé dont rien ne vient le fait tomber, sans appel au modèle ensuite", async () => {
    bench.provider = (messages, opts) => (isSummaryCall(messages) ? waitForAbort(messages, opts) : answer());
    const { sessionId, sent } = startLongTurn({ timeoutMs: 30 });
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)?.chunk.finishReason).toBe('error');
    expect(terminal(sent)?.error?.code).toBe('timeout');
    expect(bench.seenMessages.map(isSummaryCall)).toEqual([true]);
    expect(bench.seenOpts[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });

  it("délai d'inactivité : un résumé qui avance le nourrit, même plus long que le délai", async () => {
    const TIMEOUT_MS = 600;
    // Un chunk toutes les 100 ms : chaque écart reste loin sous le délai, leur somme le dépasse.
    const GAP_MS = 100;
    let summaryMs = 0;
    bench.provider = async function* (messages) {
      if (!isSummaryCall(messages)) {
        yield* answer();
        return;
      }
      const startedAt = Date.now();
      for (let i = 0; i < 9; i++) {
        await new Promise((resolve) => setTimeout(resolve, GAP_MS));
        yield { delta: `Partie ${i}. `, done: false };
      }
      summaryMs = Date.now() - startedAt;
      yield { delta: '', done: true, finishReason: 'stop' };
    };
    const { sessionId, sent } = startLongTurn({ timeoutMs: TIMEOUT_MS });
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    // Le résumé a duré plus que le délai : seul son avancement a gardé le tour en vie.
    expect(summaryMs).toBeGreaterThan(TIMEOUT_MS);
    expect(terminal(sent)?.error).toBeUndefined();
    expect(terminal(sent)?.chunk.finishReason).toBe('stop');
    expect(bench.seenMessages.map(isSummaryCall)).toEqual([true, false]);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  });
});
