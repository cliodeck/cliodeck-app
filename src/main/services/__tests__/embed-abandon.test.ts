/**
 * Une demande d'embedding sans réponse s'abandonne (J9).
 *
 * Le contrat des fournisseurs prévoit un signal pour `embed`, mais aucun appelant ne le passait.
 * L'embedding d'une question qui ne revient jamais — Ollama bloqué, modèle qui charge sans fin —
 * laissait sa requête ouverte jusqu'au redémarrage de l'app : « Arrêter » coupait la bulle, pas la
 * requête, et le tour restait inscrit au registre des opérations ; la fermeture du projet passait
 * sans la couper non plus.
 *
 * Vrais `fusionChatService`, `retrievalService` et `tropyService`, vrai `TropySync` sur un `.tpy`
 * écrit par `makeTpy`, vrais magasins dans un brain.db temporaire. Simulés : Electron et les
 * fournisseurs. Le fournisseur d'embeddings se comporte comme `fetch` : une demande retenue ne
 * répond jamais, et rejette par la raison de son signal quand il s'avorte. Sans signal, rien ne
 * l'arrête : c'est le défaut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WebContents } from 'electron';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards';
import { makeTpy } from '../../../../backend/integrations/tropy/__tests__/helpers/make-tpy';
import type { PDFDocument } from '../../../../backend/types/pdf-document';
import type { RAGExplanation } from '../../../../backend/types/chat-source';

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: () => false }, getPath: () => os.tmpdir() },
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {},
}));

interface HeldRequest {
  texts: string[];
  signal: AbortSignal | undefined;
  /** Rend la réponse : seulement pour libérer, à la fin d'un test, une demande que rien n'a coupée. */
  release: () => void;
}

const provider = vi.hoisted(() => ({
  /** Un texte qui y répond ne reçoit jamais de réponse, comme un Ollama qui charge un modèle sans fin. */
  holdWhen: null as ((text: string) => boolean) | null,
  held: [] as HeldRequest[],
  /** Les messages reçus par le modèle de génération. */
  prompts: [] as Array<Array<{ role: string; content: string }>>,
}));

const DIMENSION = 768;
function hashedVector(text: string): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % DIMENSION] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({
        id: 'fake',
        name: 'Fake',
        model: 'fake-model',
        capabilities: { chat: true, streaming: true, tools: false },
        getStatus: () => ({ state: 'ready' }),
        chat: async function* (messages: Array<{ role: string; content: string }>) {
          provider.prompts.push(messages);
          yield { delta: 'réponse', done: false };
          yield { delta: '', done: true, finishReason: 'stop' };
        },
      }),
      getEmbedding: () => ({
        id: 'local-test',
        name: 'local-test',
        model: 'hashed-bag-of-words',
        dimension: DIMENSION,
        getStatus: () => ({ state: 'ready' }),
        healthCheck: async () => ({ state: 'ready' }),
        embed: (texts: string[], opts?: { signal?: AbortSignal }): Promise<number[][]> => {
          const answer = (): number[][] => texts.map(hashedVector);
          const hold = provider.holdWhen;
          if (!hold || !texts.some(hold)) return Promise.resolve(answer());
          const signal = opts?.signal;
          return new Promise<number[][]>((resolve, reject) => {
            provider.held.push({ texts, signal, release: () => resolve(answer()) });
            if (!signal) return;
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
        dispose: async () => undefined,
      }),
      dispose: async () => undefined,
    }),
  };
});

const { tropyService } = await import('../tropy-service.js');
const { retrievalService } = await import('../retrieval-service.js');
const { fusionChatService } = await import('../fusion-chat-service.js');
const { operations } = await import('../cancellable-operation.js');
const { configManager } = await import('../config-manager.js');
const { projectManager } = await import('../project-manager.js');
const { manuscriptIndexService } = await import('../manuscript-index-service.js');
const { readingNotesIndexService } = await import('../reading-notes-index-service.js');
const { EnhancedVectorStore } = await import('../../../../backend/core/vector-store/EnhancedVectorStore.js');
const { VectorStore } = await import('../../../../backend/core/vector-store/VectorStore.js');

const ARCHIVE_NOTE =
  'Rapport du commissaire central au préfet sur la réunion tenue salle Colbert le 18 mars 1907. ' +
  'Près de huit cents dockers et charretiers y ont voté la grève générale du port de Nantes, ' +
  'malgré les réserves du syndicat, et désigné un comité chargé de porter leurs revendications.';

const PDF_TEXT =
  'La grève du port de Nantes en mars 1907 : dockers et charretiers face aux négociants, ' +
  'selon la presse locale et les rapports de police.';

/** Une attente de résultat, pas un délai : la borne n'est qu'un garde-fou pour une CI lente. */
const WAIT = { timeout: 10_000 };
/** Un signal coupé l'est tout de suite ; au-delà, c'est qu'aucun signal n'est arrivé jusqu'à `embed`. */
const ABORT_WAIT = { timeout: 2_000 };

let root = '';
let projectDir = '';
let pdfStore: InstanceType<typeof EnhancedVectorStore> | null = null;
/** Les tours lancés : un tour que rien n'a coupé finit après la libération de ses demandes. */
let turns: Array<{ sent: Sent[] }> = [];

/** Chaque question est neuve : le cache d'embeddings du module ne doit pas répondre à la place du fournisseur. */
let turn = 0;
const nextMarker = (): string => `dossier${++turn}`;

async function linkTropy(): Promise<void> {
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(tropyDir);
  const tpy = makeTpy(tropyDir, {
    projectId: 'projet-tropy-J9',
    name: 'Grèves nantaises',
    items: [{ id: 10, title: 'Rapport du commissaire central', notes: [{ text: ARCHIVE_NOTE }] }],
  });
  expect((await tropyService.openProject(tpy)).success).toBe(true);
}

async function linkAndIndex(): Promise<void> {
  await linkTropy();
  const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
  expect(result.issues).toEqual([]);
  expect(tropyService.getStatistics()?.chunkCount).toBeGreaterThan(0);
}

/** La bibliographie du projet, un PDF indexé, branchée à la recherche. */
async function openBibliography(): Promise<void> {
  const seed = new VectorStore(projectDir);
  const now = new Date();
  seed.saveDocument({
    id: 'doc1',
    fileURL: path.join(projectDir, 'greve-1907.pdf'),
    title: 'La grève de 1907',
    pageCount: 1,
    metadata: {},
    createdAt: now,
    indexedAt: now,
    lastAccessedAt: now,
    displayString: 'La grève de 1907',
  } as PDFDocument);
  seed.saveChunk(
    {
      id: 'doc1-c0',
      documentId: 'doc1',
      content: PDF_TEXT,
      pageNumber: 1,
      chunkIndex: 0,
      startPosition: 0,
      endPosition: PDF_TEXT.length,
    },
    Float32Array.from(hashedVector(PDF_TEXT))
  );
  seed.close();
  pdfStore = new EnhancedVectorStore(projectDir);
  await pdfStore.initialize();
  retrievalService.configure({ vectorStore: pdfStore, workspaceRoot: projectDir });
}

interface Sent {
  channel: string;
  payload: unknown;
}

type Envelope = { chunk: { done?: boolean; finishReason?: string }; error?: unknown };

/** Un tour de chat dont la question porte `marker`, et ce que le service envoie au renderer. */
function startTurn(marker: string, sourceType: 'secondary' | 'primary'): { sessionId: string; sent: Sent[] } {
  const sent: Sent[] = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  } as unknown as WebContents;
  const sessionId = fusionChatService.start({
    webContents,
    messages: [{ role: 'user', content: `Le ${marker} sur la grève du port de Nantes en mars 1907 ?` }],
    systemPrompt: { language: 'en' },
    retrievalOptions: { sourceType },
  });
  turns.push({ sent });
  return { sessionId, sent };
}

const terminal = (sent: Sent[]): Envelope | undefined =>
  sent
    .filter((e) => e.channel === 'fusion:chat:chunk')
    .map((e) => e.payload as Envelope)
    .find((e) => e.chunk.done);

const explanations = (sent: Sent[]): RAGExplanation[] =>
  sent
    .filter((e) => e.channel === 'fusion:chat:explanation')
    .map((e) => (e.payload as { explanation: RAGExplanation }).explanation);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-embed-abandon-'));
  projectDir = path.join(root, 'projet-cliodeck');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:9',
    ollamaChatModel: 'test',
  } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({
    topK: 5,
    similarityThreshold: 0.12,
    systemPromptLanguage: 'en',
  } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue(projectDir);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
  provider.holdWhen = null;
  provider.held.length = 0;
  provider.prompts.length = 0;
  turns = [];
  await tropyService.init(projectDir);
});

afterEach(async () => {
  // Une demande que rien n'a coupée (le défaut) se libère ici : son tour finit, et ne déborde pas
  // sur le test suivant.
  provider.holdWhen = null;
  for (const request of provider.held) request.release();
  for (const { sent } of turns) await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
  retrievalService.clear();
  manuscriptIndexService.clear();
  pdfStore?.close();
  pdfStore = null;
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('« Arrêter » pendant l’embedding de la question (J9)', () => {
  /**
   * La question part, son embedding ne revient pas ; l'historien clique « Arrêter ». Chaque requête
   * d'embedding du tour est coupée, le tour finit annulé — ni « la recherche a échoué » au panneau
   * d'explication, ni appel au modèle — et quitte le registre des opérations.
   */
  async function stopDuringEmbedding(sourceType: 'secondary' | 'primary'): Promise<void> {
    const marker = nextMarker();
    provider.holdWhen = (text) => text.includes(marker);
    const { sessionId, sent } = startTurn(marker, sourceType);
    await vi.waitFor(() => expect(provider.held.length).toBeGreaterThan(0), WAIT);

    expect(fusionChatService.cancel(sessionId)).toBe(true);

    await vi.waitFor(() => {
      expect(provider.held.map((h) => h.signal?.aborted)).not.toContain(undefined);
      expect(provider.held.every((h) => h.signal?.aborted)).toBe(true);
    }, ABORT_WAIT);
    await vi.waitFor(() => expect(terminal(sent)).toBeDefined(), WAIT);
    expect(terminal(sent)).toMatchObject({ chunk: { done: true, finishReason: 'cancelled' } });
    expect(terminal(sent)?.error).toBeUndefined();
    expect(explanations(sent).map((e) => e.search.retrievalStatus)).not.toContain('failed');
    expect(provider.prompts).toHaveLength(0);
    await vi.waitFor(() => expect(operations.find(sessionId)).toBeNull(), WAIT);
  }

  it('bibliographie : l’embedding de la question et de ses variantes est coupé, le tour finit annulé', async () => {
    await openBibliography();
    await stopDuringEmbedding('secondary');
  });

  it('archives Tropy : l’embedding de la recherche des sources primaires est coupé, le tour finit annulé', async () => {
    await linkAndIndex();
    await openBibliography();
    await stopDuringEmbedding('primary');
  });
});

describe.skipIf(!sqliteAvailable)('fermeture du projet pendant un embedding des archives (J9)', () => {
  it('une recherche des archives : sa requête est coupée, et la recherche s’arrête', async () => {
    await linkAndIndex();
    const marker = nextMarker();
    provider.holdWhen = (text) => text.includes(marker);
    const searching = tropyService.search(`Le ${marker} sur la grève de 1907`).then(
      () => null,
      (error: unknown) => error
    );
    await vi.waitFor(() => expect(provider.held).toHaveLength(1), WAIT);

    await tropyService.close();

    await vi.waitFor(() => expect(provider.held[0].signal?.aborted).toBe(true), ABORT_WAIT);
    expect(await searching).toMatchObject({ name: 'AbortError' });
  });

  it('une synchro qui embarque une source : sa requête est coupée, et la coupure n’est pas une panne', async () => {
    await linkTropy();
    provider.holdWhen = (text) => text.includes('commissaire central');
    const syncing = tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
    await vi.waitFor(() => expect(provider.held.length).toBeGreaterThan(0), WAIT);

    await tropyService.close();

    await vi.waitFor(() => expect(provider.held.every((h) => h.signal?.aborted)).toBe(true), ABORT_WAIT);
    // Projet fermé pendant la passe : la source reste à embarquer à la prochaine synchro, sans que
    // le compte rendu la dise en échec.
    const result = await syncing;
    expect(result.issues.map((issue) => issue.code)).not.toContain('embedding-failed');
  });
});
