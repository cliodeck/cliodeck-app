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
import type { ReadingNoteMappedSearchResult } from '../retrieval-service.js';
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
