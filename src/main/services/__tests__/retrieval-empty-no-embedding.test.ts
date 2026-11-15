/**
 * Un corpus sans extrait rend 0, jamais « échec », et n'embarque pas la question (H6).
 *
 * P212-F (#218) a réglé la bibliographie vide quand les embeddings répondent, et E2 les archives
 * sans projet Tropy lié. Restait le cas où l'embedding tombe (Ollama arrêté, modèle d'embeddings
 * absent) : la bibliographie, le coffre, le manuscrit et les notes de lecture embarquaient la
 * question avant de savoir s'ils avaient le moindre extrait, et un projet sans coffre Obsidian
 * affichait « Notes (vault) échec ». Le magasin du coffre s'ouvre dès que `brain.db` existe, et
 * `brain.db` naît à l'ouverture de tout projet.
 *
 * Vrai `retrievalService`, vrai `EnhancedVectorStore` sur un vrai projet, vrais magasins du coffre, du
 * manuscrit et des notes de lecture sur le même `brain.db` ; seuls les fournisseurs (embeddings,
 * modèle) sont simulés. Les témoins tiennent l'autre bord de la règle : un corpus qui a des extraits,
 * un magasin qui ne s'ouvre pas, une base illisible restent des échecs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { WebContents } from 'electron';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const state = vi.hoisted(() => ({
  messages: [] as Array<Array<{ role: string; content: string }>>,
  embedFails: false,
  /** Les textes que la recherche a demandé d'embarquer. */
  embedded: [] as string[],
}));

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: {} }));

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => ({
      getLLM: () => ({
        id: 'fake', name: 'Fake', capabilities: { chat: true, streaming: true, tools: false },
        chat: async function* (messages: Array<{ role: string; content: string }>) {
          state.messages.push(messages);
          yield { delta: 'answer', done: false };
          yield { delta: '', done: true, finishReason: 'stop' };
        },
      }),
      getEmbedding: () => ({
        id: 'fake-embed:sans-extrait',
        embed: async (texts: string[]) => {
          state.embedded.push(...texts);
          if (state.embedFails) throw new Error('Ollama embeddings: connexion refusée');
          return texts.map(() => Array(768).fill(0.1));
        },
      }),
      dispose: async () => undefined,
    }),
  };
});

import { EnhancedVectorStore } from '../../../../backend/core/vector-store/EnhancedVectorStore.js';
import { fusionChatService } from '../fusion-chat-service.js';
import { configManager } from '../config-manager.js';
import { projectManager } from '../project-manager.js';
import { retrievalService } from '../retrieval-service.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { readingNotesIndexService } from '../reading-notes-index-service.js';
import { ObsidianVaultStore } from '../../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import { ReadingNotesStore } from '../../../../backend/core/vector-store/ReadingNotesStore.js';
import { seedManuscript, seedPdf, seedReadingNotes, seedVault } from './helpers/seed-corpora.js';

let project = '';
let store: EnhancedVectorStore | null = null;
/** Chaque question est neuve : le cache d'embeddings du module ne doit pas répondre à la place du fournisseur. */
let turn = 0;
const question = (): string => `question ${++turn} sur la grève des dockers`;

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-sans-extrait-'));
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({ backend: 'ollama', ollamaURL: 'http://localhost:11434', ollamaChatModel: 'test' } as ReturnType<typeof configManager.getLLMConfig>);
  vi.spyOn(configManager, 'getRAGConfig').mockReturnValue({ topK: 5, similarityThreshold: 0.12, systemPromptLanguage: 'en' } as ReturnType<typeof configManager.getRAGConfig>);
  vi.spyOn(projectManager, 'getCurrentProjectPath').mockReturnValue(project);
  vi.spyOn(manuscriptIndexService, 'isEnabled').mockReturnValue(false);
  vi.spyOn(readingNotesIndexService, 'isEnabled').mockReturnValue(true);
  vi.spyOn(readingNotesIndexService, 'cloudConsent').mockReturnValue(false);
  store = new EnhancedVectorStore(project);
  await store.initialize();
  retrievalService.configure({ vectorStore: store, workspaceRoot: project });
});

afterEach(() => {
  retrievalService.clear();
  manuscriptIndexService.clear();
  store?.close();
  store = null;
  vi.restoreAllMocks();
  state.messages.length = 0;
  state.embedded.length = 0;
  state.embedFails = false;
  fs.rmSync(project, { recursive: true, force: true });
});

type Query = Parameters<typeof retrievalService.search>[0];

const outcomeOf = async (q: Query) =>
  Object.fromEntries((await retrievalService.search(q)).outcomes.map((o) => [o.source, o]));

/** Chaque corpus interrogé seul : aucun autre ne peut embarquer la question à sa place. */
const ALONE: Array<{ corpus: string; query: Omit<Query, 'query'> }> = [
  { corpus: 'secondary', query: { sourceType: 'secondary' } },
  { corpus: 'vault', query: { sourceType: 'vault' } },
  { corpus: 'manuscript', query: { sourceType: 'manuscript' } },
  { corpus: 'readingNotes', query: { sourceType: 'readingNotes' } },
];

const SEED: Record<string, () => void | Promise<void>> = {
  secondary: () => seedPdf(store as EnhancedVectorStore, project),
  vault: () => seedVault(project),
  manuscript: () => seedManuscript(project),
  readingNotes: () => seedReadingNotes(project),
};

type TurnExplanation = { search: { retrievalStatus?: unknown; corpora?: Array<{ source: string; attempted: boolean; ok: boolean }> } };

async function chatTurn(): Promise<{ explanation: TurnExplanation | undefined; prompt: string }> {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const webContents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } as unknown as WebContents;
  fusionChatService.start({ webContents, messages: [{ role: 'user', content: question() }], systemPrompt: { language: 'en' } });
  await vi.waitFor(() => expect(sent.some((event) => event.channel === 'fusion:chat:chunk' && (event.payload as { chunk: { done: boolean } }).chunk.done)).toBe(true));
  const payload = sent.find((event) => event.channel === 'fusion:chat:explanation')?.payload as
    | { explanation: TurnExplanation }
    | undefined;
  return {
    explanation: payload?.explanation,
    prompt: state.messages[state.messages.length - 1].map((m) => m.content).join('\n'),
  };
}

describe.skipIf(!sqliteAvailable)('un corpus sans extrait rend 0 sans embarquer la question (H6)', () => {
  it.each(ALONE)('$corpus vide, embeddings en panne : 0, pas « échec », et aucune demande d’embedding', async ({ corpus, query }) => {
    state.embedFails = true;
    const map = await outcomeOf({ query: question(), ...query });
    expect(map[corpus]).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(map[corpus].error).toBeUndefined();
    expect(state.embedded).toEqual([]);
  });

  it.each(ALONE)('témoin : $corpus avec un extrait, embeddings en panne : échec, avec la cause', async ({ corpus, query }) => {
    await SEED[corpus]();
    state.embedFails = true;
    const map = await outcomeOf({ query: question(), ...query });
    expect(map[corpus]).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map[corpus].error).toContain('connexion refusée');
  });

  it.each(ALONE)('témoin : $corpus avec un extrait, embeddings qui répondent : la question est embarquée', async ({ corpus, query }) => {
    await SEED[corpus]();
    const q = question();
    const map = await outcomeOf({ query: q, ...query });
    expect(map[corpus]).toMatchObject({ attempted: true, ok: true });
    expect(state.embedded).toContain(q);
  });

  it('projet sans coffre, embeddings en panne, tous les corpus du chat : aucun « échec »', async () => {
    state.embedFails = true;
    const map = await outcomeOf({
      query: question(),
      sourceType: 'both',
      includeVault: true,
      includeManuscript: true,
      includeReadingNotes: true,
    });
    for (const source of ['secondary', 'primary', 'vault', 'manuscript', 'readingNotes']) {
      expect(map[source], source).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    }
    expect(state.embedded).toEqual([]);
  });

  it('au chat, projet sans aucun extrait et embeddings en panne : « aucune source », pas une recherche en échec', async () => {
    state.embedFails = true;
    const { explanation, prompt } = await chatTurn();
    expect(explanation?.search.retrievalStatus).toBe('empty');
    expect(explanation?.search.corpora?.some((c) => c.attempted)).toBe(true);
    expect(explanation?.search.corpora?.filter((c) => c.attempted && !c.ok)).toEqual([]);
    expect(prompt).not.toContain('The source search failed');
    expect(prompt).not.toContain('searches failed');
  });

  it('coffre détaché (« Détacher ») pendant que son magasin est ouvert : 0, pas « échec »', async () => {
    seedVault(project);
    expect((await outcomeOf({ query: question(), sourceType: 'vault' })).vault).toMatchObject({ ok: true });
    // Le handler `fusion:vault:unlink` efface les tables par une autre connexion.
    ObsidianVaultStore.purgeObsidianData(obsidianStorePath(project));
    const map = await outcomeOf({ query: question(), sourceType: 'vault' });
    expect(map.vault).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(map.vault.error).toBeUndefined();
  });
});

/**
 * L'autre bord de la règle (S04-1-3) : « aucun extrait » se lit sur un magasin ouvert. Un magasin
 * qui ne s'ouvre pas, une base qui ne se lit plus, restent des échecs : ils ne passent jamais pour
 * vides. Le coffre et le manuscrit sont couverts par `retrieval-empty-corpus.test.ts` ; ici les notes
 * de lecture, qui rendaient `null` (« Notes de lecture 0 ») sur un magasin qui ne s'ouvre pas, et la
 * bibliographie.
 */
describe.skipIf(!sqliteAvailable)('un magasin illisible reste en échec, même vide (H6, S04-1-3)', () => {
  const malformed = (): never => {
    throw new Error('SQLITE_CORRUPT: database disk image is malformed');
  };

  it('notes de lecture : un magasin qui ne s’ouvre pas est en échec, avec la cause', async () => {
    vi.spyOn(ReadingNotesStore.prototype as unknown as { initSchema(): void }, 'initSchema').mockImplementation(malformed);
    const map = await outcomeOf({ query: question(), sourceType: 'readingNotes' });
    expect(map.readingNotes).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map.readingNotes.error).toContain('database disk image is malformed');
  });

  it('témoin : notes de lecture désactivées, aucun magasin ouvert, rien en échec', async () => {
    vi.mocked(readingNotesIndexService.isEnabled).mockReturnValue(false);
    const opened = vi.spyOn(ReadingNotesStore.prototype as unknown as { initSchema(): void }, 'initSchema').mockImplementation(malformed);
    const map = await outcomeOf({ query: question(), sourceType: 'readingNotes' });
    expect(map.readingNotes).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(opened).not.toHaveBeenCalled();
  });

  it('bibliographie : une base qui ne se lit plus est en échec, sans embarquer la question', async () => {
    // La connexion SQLite fermée sous le magasin : la moindre lecture lève.
    (store as EnhancedVectorStore).getBaseStore().close();
    state.embedFails = true;
    const map = await outcomeOf({ query: question(), sourceType: 'secondary' });
    expect(map.secondary).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map.secondary.error).not.toContain('connexion refusée');
    expect(state.embedded).toEqual([]);
  });
});
