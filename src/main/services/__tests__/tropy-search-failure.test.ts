/**
 * Une vraie panne des archives se voit (E2).
 *
 * `tropyService.search` enveloppait toute sa recherche dans un `catch` qui
 * rendait `[]` : Ollama arrêté, index des archives calculé par un autre modèle
 * d'embeddings, aucun fournisseur — tout devenait « aucun extrait ».
 * `fanOutCorpora` ne voyait jamais l'exception : les archives passaient pour
 * vides (« Archives 0 »). Quand elles étaient seules à tomber — index d'un
 * autre modèle —, ni bande d'échec ni consigne d'échec au modèle, et
 * l'assistant répondait comme si le fonds ne contenait rien ; si aucun autre
 * corpus ne trouvait rien, la bande disait même « Aucune source pertinente
 * trouvée. ». Quand toute la
 * recherche par embeddings tombait, la bande « Certaines recherches ont
 * échoué » venait des autres corpus (bibliographie, vault), et les archives
 * y comptaient pour 0 ; elle dit désormais « La recherche de sources a
 * échoué. ».
 *
 * Défaut inverse de P212-F, et c'est le risque de ce correctif : un projet
 * sans Tropy, ou un Tropy encore vide, n'a rien à trouver. Il reste silencieux
 * — et n'embarque pas la question pour rien, si bien qu'un Ollama arrêté ne
 * le fait pas passer pour en panne.
 *
 * Vrai `tropyService`, vrai `TropySync` sur un .tpy écrit par `makeTpy`, vrais
 * `PrimarySourcesVectorStore` et `EnhancedVectorStore` dans un brain.db
 * temporaire, vrais `retrievalService` et `fusionChatService`. Simulés :
 * Electron et les fournisseurs (un vecteur calculé localement, sans réseau),
 * qui tombent en panne sur commande.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WebContents } from 'electron';
import Database from 'better-sqlite3';
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

/**
 * `ok` : répond ; `down` : tout échoue, comme Ollama arrêté ; `absent` : le
 * registre ne se construit pas, aucun fournisseur ; `other-model` : répond en
 * 1024 dimensions, comme un modèle d'embeddings changé sans réindexer les
 * archives (calculées en 768).
 */
type ProviderMode = 'ok' | 'down' | 'absent' | 'other-model';
const provider = vi.hoisted(() => ({
  mode: 'ok' as ProviderMode,
  /** Chaque texte demandé au fournisseur, panne ou pas. */
  embedded: [] as string[],
  /** Les messages reçus par le modèle de génération, tour par tour. */
  prompts: [] as Array<Array<{ role: string; content: string }>>,
}));

const DIMENSION = 768;
const OTHER_DIMENSION = 1024;
function hashedVector(text: string, dimension: number): number[] {
  const v = new Array<number>(dimension).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % dimension] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../../../../backend/core/llm/providers/cliodeck-config-adapter.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../backend/core/llm/providers/cliodeck-config-adapter.js')>();
  return {
    ...original,
    createRegistryFromClioDeckConfig: () => {
      if (provider.mode === 'absent') throw new Error('aucun fournisseur configuré');
      return {
        getLLM: () => ({
          id: 'fake',
          name: 'Fake',
          capabilities: { chat: true, streaming: true, tools: false },
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
          get dimension() {
            return provider.mode === 'other-model' ? OTHER_DIMENSION : DIMENSION;
          },
          getStatus: () => ({ state: 'ready' }),
          healthCheck: async () => ({ state: 'ready' }),
          embed: async (texts: string[]) => {
            provider.embedded.push(...texts);
            if (provider.mode === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
            const dimension = provider.mode === 'other-model' ? OTHER_DIMENSION : DIMENSION;
            return texts.map((t) => hashedVector(t, dimension));
          },
          dispose: async () => undefined,
        }),
        dispose: async () => undefined,
      };
    },
  };
});

const { tropyService } = await import('../tropy-service.js');
const { retrievalService } = await import('../retrieval-service.js');
const { fusionChatService } = await import('../fusion-chat-service.js');
const { configManager } = await import('../config-manager.js');
const { projectManager } = await import('../project-manager.js');
const { manuscriptIndexService } = await import('../manuscript-index-service.js');
const { readingNotesIndexService } = await import('../reading-notes-index-service.js');
const { EnhancedVectorStore } = await import('../../../../backend/core/vector-store/EnhancedVectorStore.js');
const { VectorStore } = await import('../../../../backend/core/vector-store/VectorStore.js');
const { EmbeddingSpaceMismatchError } = await import('../../../../backend/core/vector-store/embedding-space.js');

// MARK: - Données

const ARCHIVE_NOTE =
  'Rapport du commissaire central au préfet sur la réunion tenue salle Colbert le 18 mars 1907. ' +
  'Près de huit cents dockers et charretiers y ont voté la grève générale du port de Nantes, ' +
  'malgré les réserves du syndicat, et désigné un comité chargé de porter leurs revendications.';

const SECOND_NOTE =
  'Lettre du syndicat des dockers au maire de Nantes, datée du 20 mars 1907, demandant que la salle ' +
  'Colbert reste ouverte aux réunions ouvrières pendant toute la durée du conflit avec les négociants.';

const PDF_TEXT =
  'La grève du port de Nantes en mars 1907 : dockers et charretiers face aux négociants, ' +
  'selon la presse locale et les rapports de police.';

let root = '';
let projectDir = '';
let pdfStore: InstanceType<typeof EnhancedVectorStore> | null = null;

/** Chaque question est neuve : le cache d'embeddings du module ne doit pas répondre à la place du fournisseur. */
let turn = 0;
const question = (): string => `question ${++turn} sur la grève du port de Nantes en mars 1907`;
const embeddedQuestion = (q: string): boolean => provider.embedded.some((t) => t.includes(q));

async function linkTropy(): Promise<void> {
  const tropyDir = path.join(root, 'tropy');
  fs.mkdirSync(tropyDir);
  const tpy = makeTpy(tropyDir, {
    projectId: 'projet-tropy-E2',
    name: 'Grèves nantaises',
    items: [{ id: 10, title: 'Rapport du commissaire central', notes: [{ text: ARCHIVE_NOTE }] }],
  });
  expect((await tropyService.openProject(tpy)).success).toBe(true);
}

/** Lie le projet Tropy et en embarque les extraits, en 768 dimensions. */
async function linkAndIndex(): Promise<void> {
  await linkTropy();
  const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
  expect(result.issues).toEqual([]);
  expect(tropyService.getStatistics()?.chunkCount).toBeGreaterThan(0);
}

/** Change de fournisseur comme après un changement de réglages : Tropy refait le sien. */
async function setTropyProvider(mode: ProviderMode): Promise<void> {
  provider.mode = mode;
  await tropyService.rebuildProviders({ embeddingChanged: true });
}

/**
 * Ouvre la bibliographie du projet et y branche la recherche. `pdfDimension` :
 * un PDF indexé, à cette dimension ; absent, aucun PDF.
 */
async function openBibliography(pdfDimension?: number): Promise<void> {
  if (pdfDimension) {
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
      Float32Array.from(hashedVector(PDF_TEXT, pdfDimension))
    );
    seed.close();
  }
  pdfStore = new EnhancedVectorStore(projectDir);
  await pdfStore.initialize();
  retrievalService.configure({ vectorStore: pdfStore, workspaceRoot: projectDir });
}

const outcomeOf = async (q: Parameters<typeof retrievalService.search>[0]) => {
  const result = await retrievalService.search(q);
  return { result, map: Object.fromEntries(result.outcomes.map((o) => [o.source, o])) };
};

type CorpusLine = NonNullable<RAGExplanation['search']['corpora']>[number];

/**
 * Un tour de chat : le statut de la bande, la ligne « Par corpus » des détails
 * (un corpus par source) et le prompt reçu par le modèle.
 */
async function chatTurn(): Promise<{
  status: RAGExplanation['search']['retrievalStatus'];
  corpora: Partial<Record<CorpusLine['source'], CorpusLine>>;
  prompt: string;
}> {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  } as unknown as WebContents;
  fusionChatService.start({ webContents, messages: [{ role: 'user', content: question() }], systemPrompt: { language: 'en' } });
  // Attend la fin du tour, pas un délai : la borne n'est qu'un garde-fou pour une CI lente.
  await vi.waitFor(
    () =>
      expect(
        sent.some(
          (event) =>
            event.channel === 'fusion:chat:chunk' && (event.payload as { chunk: { done: boolean } }).chunk.done
        )
      ).toBe(true),
    { timeout: 10_000 }
  );
  const explanation = sent.find((event) => event.channel === 'fusion:chat:explanation')?.payload as
    | { explanation: RAGExplanation }
    | undefined;
  return {
    status: explanation?.explanation.search.retrievalStatus,
    corpora: Object.fromEntries(
      (explanation?.explanation.search.corpora ?? []).map((line) => [line.source, line])
    ),
    prompt: provider.prompts[provider.prompts.length - 1].map((m) => m.content).join('\n'),
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-tropy-panne-'));
  projectDir = path.join(root, 'projet-cliodeck');
  fs.mkdirSync(projectDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(configManager, 'getLLMConfig').mockReturnValue({
    backend: 'ollama',
    ollamaURL: 'http://127.0.0.1:1',
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
  provider.mode = 'ok';
  provider.embedded.length = 0;
  provider.prompts.length = 0;
  // Comme à l'ouverture d'un projet dans l'app : le service Tropy s'ouvre
  // toujours, qu'un projet Tropy soit lié ou non.
  await tropyService.init(projectDir);
});

afterEach(async () => {
  retrievalService.clear();
  manuscriptIndexService.clear();
  pdfStore?.close();
  pdfStore = null;
  await tropyService.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// MARK: - Le service

describe.skipIf(!sqliteAvailable)('tropyService.search : des archives vides ne sont pas en panne', () => {
  it('aucun projet ouvert : liste vide', async () => {
    await tropyService.close();
    await expect(tropyService.search(question())).resolves.toEqual([]);
  });

  it('projet sans Tropy, Ollama arrêté : liste vide, sans embarquer la question', async () => {
    provider.mode = 'down';
    const q = question();
    await expect(tropyService.search(q)).resolves.toEqual([]);
    expect(embeddedQuestion(q)).toBe(false);
  });

  it('projet Tropy lié mais rien d’indexé encore, Ollama arrêté : liste vide, sans embarquer la question', async () => {
    await linkTropy();
    provider.mode = 'down';
    const q = question();
    await expect(tropyService.search(q)).resolves.toEqual([]);
    expect(embeddedQuestion(q)).toBe(false);
  });

  it('projet Tropy synchronisé sans fournisseur, donc sans extrait : liste vide', async () => {
    await linkTropy();
    await setTropyProvider('absent');
    const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });
    expect(result.issues).toEqual([{ code: 'no-embedding-provider', sources: 1 }]);

    await expect(tropyService.search(question())).resolves.toEqual([]);
  });
});

describe.skipIf(!sqliteAvailable)('tropyService.search : une vraie panne lève', () => {
  it('témoin : archives indexées, fournisseur en marche, des extraits', async () => {
    await linkAndIndex();
    const results = await tropyService.search(question());
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.content).toContain('grève générale du port de Nantes');
  });

  it('archives indexées, Ollama arrêté : la recherche lève', async () => {
    await linkAndIndex();
    provider.mode = 'down';
    await expect(tropyService.search(question())).rejects.toThrow('ECONNREFUSED');
  });

  it('archives indexées, aucun fournisseur : la recherche lève', async () => {
    await linkAndIndex();
    await setTropyProvider('absent');
    await expect(tropyService.search(question())).rejects.toThrow('embedding provider not configured');
  });

  it('archives indexées par un autre modèle : la recherche lève l’erreur des PDF, de type « dimension », et non l’erreur brute de hnswlib (L06-9)', async () => {
    await linkAndIndex();
    provider.mode = 'other-model';
    const error = await tropyService.search(question()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingSpaceMismatchError);
    expect(error).toMatchObject({
      kind: 'dimension',
      code: 'embedding_dimension_mismatch',
      expected: DIMENSION,
      actual: OTHER_DIMENSION,
    });
  });
});

// MARK: - La synchro après un changement de modèle

describe.skipIf(!sqliteAvailable)('synchro Tropy après un changement de modèle : rien n’est écrit, et c’est dit (L06-9)', () => {
  /** Les dimensions des vecteurs des archives, en base. */
  function dimensionsInBase(): number[] {
    const db = new Database(path.join(projectDir, '.cliodeck', 'brain.db'), { readonly: true });
    try {
      return (db.prepare('SELECT DISTINCT length(embedding) / 4 AS d FROM tropy_chunks').all() as Array<{ d: number }>).map(
        (r) => r.d
      );
    } finally {
      db.close();
    }
  }

  it('une pièce ajoutée dans Tropy, le modèle passé en 1024 : aucune écriture, « embedding-space-changed », et les archives d’avant toujours servies', async () => {
    await linkAndIndex();
    const chunkCount = tropyService.getStatistics()?.chunkCount;
    // L'historien ajoute une pièce dans Tropy, puis synchronise avec le nouveau modèle.
    makeTpy(path.join(root, 'tropy'), {
      projectId: 'projet-tropy-E2',
      name: 'Grèves nantaises',
      items: [
        { id: 10, title: 'Rapport du commissaire central', notes: [{ text: ARCHIVE_NOTE }] },
        { id: 20, title: 'Lettre du syndicat des dockers', notes: [{ text: SECOND_NOTE }] },
      ],
    });
    await setTropyProvider('other-model');

    const result = await tropyService.sync({ performOCR: false, ocrLanguage: 'fra' });

    expect(result.issues).toEqual([
      { code: 'embedding-space-changed', sources: 1, expected: DIMENSION, actual: OTHER_DIMENSION },
    ]);
    expect(tropyService.getStatistics()).toMatchObject({ sourceCount: 2, chunkCount });
    expect(dimensionsInBase()).toEqual([DIMENSION]);
    // L'ancien modèle revenu, l'index en mémoire n'a pas été vidé : la première pièce est trouvée.
    await setTropyProvider('ok');
    const results = await tropyService.search(question());
    expect(results[0]?.chunk.content).toContain('grève générale du port de Nantes');
  });
});

// MARK: - La recherche de bout en bout

describe.skipIf(!sqliteAvailable)('recherche multi-corpus : la panne des archives est rapportée', () => {
  it('archives d’un autre modèle : « primary » en échec avec le message, la bibliographie rend ses extraits', async () => {
    await linkAndIndex();
    // Les PDF ont été réindexés avec le nouveau modèle, pas les archives.
    await openBibliography(OTHER_DIMENSION);
    provider.mode = 'other-model';

    const { result, map } = await outcomeOf({ query: question(), sourceType: 'both' });

    expect(map.primary).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(map.primary.error).toContain(`expected ${DIMENSION}, got ${OTHER_DIMENSION}`);
    expect(map.secondary).toMatchObject({ attempted: true, ok: true, hitCount: 1 });
    expect(result.hits.map((h) => h.chunk.id)).toEqual(['doc1-c0']);
  });

  it('Ollama arrêté, archives indexées : « primary » en échec avec le message', async () => {
    await linkAndIndex();
    await openBibliography();
    provider.mode = 'down';

    const { map } = await outcomeOf({ query: question(), sourceType: 'both' });

    expect(map.primary).toMatchObject({ attempted: true, ok: false });
    expect(map.primary.error).toContain('ECONNREFUSED');
  });

  it('projet sans Tropy, Ollama arrêté : « primary » réussit avec 0 extrait, seule la bibliographie tombe', async () => {
    await openBibliography();
    provider.mode = 'down';

    const { map } = await outcomeOf({ query: question(), sourceType: 'both' });

    expect(map.primary).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(map.primary.error).toBeUndefined();
    expect(map.secondary).toMatchObject({ attempted: true, ok: false });
  });
});

describe.skipIf(!sqliteAvailable)('au chat : la bande et la consigne d’échec', () => {
  it('archives en panne, bibliographie en marche : statut « partiel » et consigne d’échec au modèle', async () => {
    await linkAndIndex();
    await openBibliography(OTHER_DIMENSION);
    provider.mode = 'other-model';

    const { status, prompt } = await chatTurn();

    expect(status).toBe('partial');
    expect(prompt).toContain('searches failed');
  });

  // Le pire cas d'avant le correctif : aucun autre corpus ne trouve rien, et
  // la bande « Aucune source pertinente trouvée. » (`empty`) affirmait que les
  // archives n'avaient rien, alors que leur recherche avait levé.
  it('archives seules en panne, rien ailleurs : statut « partiel », jamais « aucune source pertinente »', async () => {
    await linkAndIndex();
    await openBibliography();
    provider.mode = 'other-model';

    const { status, corpora, prompt } = await chatTurn();

    expect(status).toBe('partial');
    expect(corpora.primary).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(corpora.secondary).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(prompt).toContain('searches failed');
  });

  it('projet sans Tropy, bibliographie en marche : aucune bande, aucune consigne d’échec', async () => {
    await openBibliography(DIMENSION);

    const { status, prompt } = await chatTurn();

    expect(status).toBeUndefined();
    expect(prompt).not.toContain('searches failed');
  });

  // Le contrôle à la main de la PR : quand les embeddings tombent, tous les
  // corpus qui embarquent la question tombent avec eux. La bande dit alors
  // « La recherche de sources a échoué. » (`failed`), pas « Certaines
  // recherches ont échoué » : c'était la bande d'avant le correctif, avec
  // « Archives 0 » dans le détail. Seule la ligne « Par corpus » nomme les archives.
  it('embeddings en panne, archives indexées : statut « échec », les archives comptées en échec', async () => {
    await linkAndIndex();
    await openBibliography(DIMENSION);
    provider.mode = 'down';

    const { status, corpora, prompt } = await chatTurn();

    expect(status).toBe('failed');
    expect(corpora.primary).toMatchObject({ attempted: true, ok: false, hitCount: 0 });
    expect(corpora.secondary).toMatchObject({ attempted: true, ok: false });
    expect(prompt).toContain('searches failed');
  });

  it('projet sans Tropy, embeddings en panne : la bande vient des autres corpus, les archives restent à 0', async () => {
    await openBibliography(DIMENSION);
    provider.mode = 'down';

    const { status, corpora } = await chatTurn();

    expect(status).toBe('partial');
    expect(corpora.primary).toMatchObject({ attempted: true, ok: true, hitCount: 0 });
    expect(corpora.secondary).toMatchObject({ attempted: true, ok: false });
  });
});
