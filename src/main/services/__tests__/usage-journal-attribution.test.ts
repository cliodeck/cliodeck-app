/**
 * Journal d'usage IA : un événement s'écrit dans le `journal.db` du projet qui l'a produit, ou
 * nulle part (S10-1-33, L03-6).
 *
 * Le décorateur des fournisseurs émet l'événement à la fin de l'appel, et le service l'écrivait
 * dans le journal ouvert à ce moment-là : un appel lancé dans A et fini après l'ouverture de B
 * entrait dans le journal de B, qui se copie et se publie seul (ADR 0007). L'attribution passe
 * avant la complétude : mieux vaut un événement perdu, et dit, qu'un événement dans le mauvais
 * journal. Un même dossier par un autre chemin (un lien) reste le même projet.
 *
 * Vrais `context.ts`, `instrumentLLM`, `instrumentEmbedding` et service ; seul le magasin SQLite
 * est remplacé par un faux qui garde les événements reçus, rangés par chemin de base.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ChatChunk,
  EmbeddingProvider,
  LLMProvider,
  ProviderStatus,
} from '../../../../backend/core/llm/providers/base.js';
import type { InferenceEvent } from '../../../../backend/core/usage-journal/types.js';
import { symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

const stores = vi.hoisted(() => new Map<string, { events: InferenceEvent[] }>());

vi.mock('../../../../backend/core/usage-journal/UsageJournalStore.js', () => ({
  UsageJournalStore: class {
    readonly events: InferenceEvent[] = [];
    constructor(dbPath: string) {
      stores.set(dbPath, this);
    }
    insertEvents(events: InferenceEvent[]): void {
      this.events.push(...events);
    }
    close(): void {}
  },
}));

import { usageJournalService } from '../usage-journal-service.js';
import { instrumentEmbedding, instrumentLLM } from '../../../../backend/core/llm/providers/instrument.js';
import { runBatch, runWithJournalContext } from '../../../../backend/core/usage-journal/context.js';

const READY: ProviderStatus = { state: 'ready' };

/** Les événements arrivés dans le `journal.db` d'un projet. */
const eventsOf = (project: string): InferenceEvent[] =>
  stores.get(path.join(project, '.cliodeck', 'journal.db'))?.events ?? [];

/** Un appel retenu : il a commencé (`running`) et ne finit qu'une fois relâché. */
interface Held {
  running: Promise<void>;
  release: () => void;
}

function hold(): Held & { gate: Promise<void>; started: () => void } {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const running = new Promise<void>((resolve) => (started = resolve));
  return { gate, running, release, started };
}

/** Un modèle local qui répond en deux morceaux, le second retenu. */
function heldLLM(): Held & { llm: LLMProvider } {
  const h = hold();
  const inner: LLMProvider = {
    id: 'fake',
    name: 'Fake',
    model: 'fake-model',
    capabilities: { chat: true, streaming: true, tools: false, embeddings: false },
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    async *chat(): AsyncIterable<ChatChunk> {
      yield { delta: 'début', done: false };
      h.started();
      await h.gate;
      yield { delta: ' fin', done: true, finishReason: 'stop' };
    },
    complete: async () => '',
  };
  return { llm: instrumentLLM(inner, 'ollama', 'http://127.0.0.1:11434'), running: h.running, release: h.release };
}

/** Un fournisseur d'embeddings local dont le premier appel est retenu. */
function heldEmbedding(): Held & { embedding: EmbeddingProvider } {
  const h = hold();
  const inner: EmbeddingProvider = {
    id: 'fake-emb',
    name: 'Fake Emb',
    dimension: 3,
    model: 'fake-embed',
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    embed: async (texts: string[]) => {
      h.started();
      await h.gate;
      return texts.map(() => [0, 0, 0]);
    },
  };
  return {
    embedding: instrumentEmbedding(inner, 'ollama', 'http://127.0.0.1:11434'),
    running: h.running,
    release: h.release,
  };
}

async function drain(stream: AsyncIterable<ChatChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Le contenu n'importe pas ici : seule la fin de l'appel émet l'événement.
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-journal-usage-'));
let A = '';
let B = '';
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  A = fs.mkdtempSync(path.join(root, 'A-'));
  B = fs.mkdtempSync(path.join(root, 'B-'));
  stores.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  usageJournalService.close();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const warnings = (): string => warn.mock.calls.flat().map(String).join('\n');

describe('journal d’usage : un appel isolé reste dans son projet (S10-1-33)', () => {
  it('un appel démarré dans A et fini après l’ouverture de B n’entre pas dans le journal de B', async () => {
    usageJournalService.init(A);
    const { llm, running, release } = heldLLM();
    const call = runWithJournalContext({ workspaceRoot: A }, () =>
      drain(llm.chat([{ role: 'user', content: 'question' }]))
    );
    await running;

    usageJournalService.init(B);
    release();
    await call;
    usageJournalService.close();

    expect(eventsOf(B)).toEqual([]);
    expect(eventsOf(A)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('témoin : fini dans A, l’appel entre dans le journal de A', async () => {
    usageJournalService.init(A);
    const { llm, running, release } = heldLLM();
    const call = runWithJournalContext({ workspaceRoot: A }, () =>
      drain(llm.chat([{ role: 'user', content: 'question' }]))
    );
    await running;
    release();
    await call;
    usageJournalService.close();

    expect(eventsOf(A)).toHaveLength(1);
    expect(eventsOf(A)[0]).toMatchObject({ kind: 'completion', workspace: A, status: 'ok' });
  });

  it.skipIf(!symlinkAvailable)('le même dossier par un lien est le même projet : l’appel est gardé', async () => {
    const link = path.join(root, `lien-${path.basename(A)}`);
    fs.symlinkSync(A, link);
    usageJournalService.init(A);
    const { llm, release } = heldLLM();
    release();
    await runWithJournalContext({ workspaceRoot: link }, () =>
      drain(llm.chat([{ role: 'user', content: 'question' }]))
    );
    usageJournalService.close();

    expect(eventsOf(A)).toHaveLength(1);
    fs.unlinkSync(link);
  });
});

describe('journal d’usage : un lot d’embeddings reste dans son projet (H7, S10-1-33)', () => {
  it('un embedding_batch démarré dans A et fini après l’ouverture de B n’entre pas dans le journal de B', async () => {
    usageJournalService.init(A);
    const { embedding, running, release } = heldEmbedding();
    const batch = runWithJournalContext({ workspaceRoot: A }, () =>
      runBatch('pdf', () => embedding.embed(['un extrait', 'un autre']))
    );
    await running;

    usageJournalService.init(B);
    release();
    await batch;
    usageJournalService.close();

    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('témoin : fini dans A, le lot entre dans le journal de A, une seule fois', async () => {
    usageJournalService.init(A);
    const { embedding, release } = heldEmbedding();
    release();
    await runWithJournalContext({ workspaceRoot: A }, () =>
      runBatch('pdf', () => embedding.embed(['un extrait', 'un autre']))
    );
    usageJournalService.close();

    expect(eventsOf(A)).toHaveLength(1);
    expect(eventsOf(A)[0]).toMatchObject({ kind: 'embedding_batch', workspace: A, chunkCount: 2 });
  });

  it.skipIf(!symlinkAvailable)('le même dossier par un lien est le même projet : le lot est gardé', async () => {
    const link = path.join(root, `lien-lot-${path.basename(A)}`);
    fs.symlinkSync(A, link);
    usageJournalService.init(A);
    const { embedding, release } = heldEmbedding();
    release();
    await runWithJournalContext({ workspaceRoot: link }, () =>
      runBatch('pdf', () => embedding.embed(['un extrait']))
    );
    usageJournalService.close();

    expect(eventsOf(A)).toHaveLength(1);
    fs.unlinkSync(link);
  });
});

/**
 * Sans contexte qui porte la racine du projet : la génération de diapositives n'en pose pas, et
 * l'analyse de similarité, l'indexation du vault Obsidian ou la synchro Tropy n'en posaient pas.
 * La racine d'un appel ou d'un lot est celle du journal ouvert quand il commence, pas quand il
 * finit. Une opération en plusieurs appels doit poser la sienne à son entrée : voir
 * `usage-journal-indexing-passes.test.ts` et `similarity-journal.test.ts`.
 */
describe('journal d’usage : sans racine posée par l’appelant, le projet est celui du début (S10-1-33)', () => {
  it('un appel démarré dans A et fini après l’ouverture de B n’entre pas dans le journal de B', async () => {
    usageJournalService.init(A);
    const { llm, running, release } = heldLLM();
    const call = drain(llm.chat([{ role: 'user', content: 'question' }]));
    await running;

    usageJournalService.init(B);
    release();
    await call;
    usageJournalService.close();

    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('un embedding isolé démarré dans A et fini après l’ouverture de B n’entre pas dans le journal de B', async () => {
    usageJournalService.init(A);
    const { embedding, running, release } = heldEmbedding();
    const call = embedding.embed(['une question']);
    await running;

    usageJournalService.init(B);
    release();
    await call;
    usageJournalService.close();

    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('un lot démarré dans A et fini après l’ouverture de B n’entre pas dans le journal de B', async () => {
    usageJournalService.init(A);
    const { embedding, running, release } = heldEmbedding();
    const batch = runBatch('obsidian', () => embedding.embed(['une note', 'une autre']));
    await running;

    usageJournalService.init(B);
    release();
    await batch;
    usageJournalService.close();

    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('témoin : fini dans A, l’appel et le lot entrent dans le journal de A, sous sa racine', async () => {
    usageJournalService.init(A);
    const { llm, release: releaseLLM } = heldLLM();
    const { embedding, release: releaseEmbedding } = heldEmbedding();
    releaseLLM();
    releaseEmbedding();
    await drain(llm.chat([{ role: 'user', content: 'question' }]));
    await runBatch('obsidian', () => embedding.embed(['une note']));
    usageJournalService.close();

    expect(eventsOf(A)).toHaveLength(2);
    expect(eventsOf(A)[0]).toMatchObject({ kind: 'completion', workspace: A });
    expect(eventsOf(A)[1]).toMatchObject({ kind: 'embedding_batch', workspace: A, corpus: 'obsidian' });
  });
});

/**
 * Sans localité donnée par le décorateur, le service la déduit du fournisseur. Il ne connaissait
 * qu'Ollama : le modèle embarqué, qui ne quitte pas la machine, était compté « cloud » (S10-1-11).
 */
describe('journal d’usage : la localité déduite du fournisseur (S10-1-11)', () => {
  it('le modèle embarqué est local ; témoins : Ollama local, Anthropic distant', () => {
    usageJournalService.init(A);
    for (const provider of ['embedded', 'ollama', 'anthropic']) {
      usageJournalService.record({
        kind: 'completion',
        provider,
        model: 'm',
        durationMs: 1,
        tokensEstimated: true,
        status: 'ok',
        workspaceRoot: A,
      });
    }
    usageJournalService.close();

    expect(eventsOf(A).map((e) => [e.provider, e.isLocal])).toEqual([
      ['embedded', true],
      ['ollama', true],
      ['anthropic', false],
    ]);
  });
});
