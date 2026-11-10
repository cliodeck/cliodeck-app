/**
 * Journal d'usage IA : une indexation faite de plusieurs appels au fournisseur reste dans son
 * projet, jusqu'à son dernier appel (S10-1-33, L03-6, revue).
 *
 * Le décorateur des fournisseurs lit la racine au début de chaque appel. Sans contexte posé par
 * l'opération, c'est celle du journal ouvert à cet instant. Or l'indexation du manuscrit (un
 * chapitre après l'autre) et celle des notes de lecture (une note après l'autre) ne s'arrêtent pas
 * à l'ouverture d'un autre projet : leurs appels lancés après `init(B)` prenaient la racine de B,
 * et leurs événements `embedding` entraient dans le `journal.db` de B, qui se publie seul
 * (ADR 0007). Le cas est courant : une montée de `CHUNKER_VERSION` réembarque tout le livre à la
 * première sauvegarde, et les notes s'indexent en fond à l'ouverture du projet.
 *
 * Vrais services d'indexation, vrai `brain.db`, vrais `instrumentEmbedding`, `context.ts` et
 * service du journal ; seul le magasin du journal d'usage est remplacé par un faux qui garde les
 * événements reçus, rangés par chemin de base. Le premier appel du fournisseur est retenu le temps
 * d'ouvrir B, comme une bascule de projet pendant l'indexation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { InferenceEvent } from '../../../../backend/core/usage-journal/types.js';
import type { EmbeddingProvider, ProviderStatus } from '../../../../backend/core/llm/providers/base.js';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';

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
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { ReadingNotesIndexService } from '../reading-notes-index-service.js';
import {
  ReadingNotesStore,
  readingNotesStorePath,
} from '../../../../backend/core/vector-store/ReadingNotesStore.js';
import { instrumentEmbedding } from '../../../../backend/core/llm/providers/instrument.js';

const READY: ProviderStatus = { state: 'ready' };

/** Les événements arrivés dans le `journal.db` d'un projet. */
const eventsOf = (project: string): InferenceEvent[] =>
  stores.get(path.join(project, '.cliodeck', 'journal.db'))?.events ?? [];

interface HeldEmbedder {
  embedder: EmbeddingProvider;
  /** Résolue quand le premier appel a commencé : la passe a lu son projet. */
  entered: Promise<void>;
  release: () => void;
  calls: () => number;
}

/** Un fournisseur local, instrumenté comme celui du registre, dont le premier appel attend `release()`. */
function heldEmbedder(): HeldEmbedder {
  let enter = (): void => undefined;
  let release = (): void => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = true;
  let calls = 0;
  const inner: EmbeddingProvider = {
    id: 'fake-emb',
    name: 'Fake Emb',
    dimension: 8,
    model: 'fake-embed',
    getStatus: () => READY,
    healthCheck: async () => READY,
    dispose: async () => undefined,
    embed: async (texts: string[]) => {
      calls += 1;
      if (held) {
        held = false;
        enter();
        await released;
      }
      return texts.map((t, i) => Array.from({ length: 8 }, (_, d) => ((t.length + i + d) % 7) / 7 + 0.1));
    },
  };
  return {
    embedder: instrumentEmbedding(inner, 'ollama', 'http://127.0.0.1:11434'),
    entered,
    release,
    calls: () => calls,
  };
}

/** Un livre de deux chapitres : deux appels au fournisseur, un par chapitre. */
function writeBook(root: string): void {
  fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'project.json'),
    JSON.stringify({
      id: 'livre',
      name: 'Livre',
      path: root,
      type: 'book',
      createdAt: '',
      updatedAt: '',
      chapters: [
        { id: 'c1', title: 'Un', filePath: 'chapters/01.md', order: 0, kind: 'chapter' },
        { id: 'c2', title: 'Deux', filePath: 'chapters/02.md', order: 1, kind: 'chapter' },
      ],
    })
  );
  fs.writeFileSync(path.join(root, 'chapters', '01.md'), '# Un\n\nLe port de Danzig est disputé depuis 1919.\n');
  fs.writeFileSync(path.join(root, 'chapters', '02.md'), '# Deux\n\nLes élections de 1932 marquent une rupture.\n');
}

/** Deux notes de lecture : deux appels au fournisseur, un par note. */
function writeReadingNotes(root: string): void {
  const dir = path.join(root, 'reading-notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'a.md'),
    '---\ncitekey: Braudel_1949\ntitle: La Méditerranée\n---\n\nUne note sur la Méditerranée.\n'
  );
  fs.writeFileSync(
    path.join(dir, 'b.md'),
    '---\ncitekey: Bloch_1939\ntitle: La société féodale\n---\n\nUne note sur la féodalité.\n'
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-journal-passes-'));
let A = '';
let B = '';
let warn: ReturnType<typeof vi.spyOn>;
let notes: ReadingNotesIndexService | null = null;

beforeEach(() => {
  A = fs.mkdtempSync(path.join(tmp, 'A-'));
  B = fs.mkdtempSync(path.join(tmp, 'B-'));
  stores.clear();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  usageJournalService.close();
  manuscriptIndexService.clear();
  notes?.clear();
  notes = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const warnings = (): string => warn.mock.calls.flat().map(String).join('\n');

function readingNotesService(): ReadingNotesIndexService {
  notes = new ReadingNotesIndexService({
    isEnabled: () => true,
    openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
  });
  return notes;
}

describe.skipIf(!sqliteAvailable)('journal d’usage : l’indexation du manuscrit reste dans son projet (S10-1-33)', () => {
  it('le chapitre embarqué après l’ouverture de B n’entre pas dans le journal de B', async () => {
    writeBook(A);
    const { embedder, entered, release, calls } = heldEmbedder();
    usageJournalService.init(A);
    manuscriptIndexService.configure(A);
    const pending = manuscriptIndexService.index(embedder);
    await entered;

    // Ouverture de B, comme `project:load` : journal de A fermé, celui de B ouvert, service
    // reconfiguré. La passe de A continue avec son second chapitre.
    usageJournalService.close();
    usageJournalService.init(B);
    manuscriptIndexService.configure(B);
    release();
    const report = await pending;
    usageJournalService.close();

    // Les deux chapitres sont bien passés par le fournisseur : le second après `init(B)`.
    expect(report.indexed).toBe(2);
    expect(calls()).toBe(2);
    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('témoin : sans bascule, les deux appels entrent dans le journal de A, sous sa racine', async () => {
    writeBook(A);
    const { embedder, release } = heldEmbedder();
    release();
    usageJournalService.init(A);
    manuscriptIndexService.configure(A);
    const report = await manuscriptIndexService.index(embedder);
    usageJournalService.close();

    expect(report.indexed).toBe(2);
    expect(eventsOf(A).map((e) => [e.kind, e.workspace])).toEqual([
      ['embedding', A],
      ['embedding', A],
    ]);
  });
});

describe.skipIf(!sqliteAvailable)('journal d’usage : l’indexation des notes de lecture reste dans son projet (S10-1-33)', () => {
  it('la note embarquée après l’ouverture de B n’entre pas dans le journal de B', async () => {
    writeReadingNotes(A);
    const svc = readingNotesService();
    const { embedder, entered, release, calls } = heldEmbedder();
    usageJournalService.init(A);
    svc.configure(A);
    const pending = svc.index(embedder);
    await entered;

    usageJournalService.close();
    usageJournalService.init(B);
    svc.configure(B);
    release();
    const report = await pending;
    usageJournalService.close();

    expect(report.indexed).toBe(2);
    expect(calls()).toBe(2);
    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('« Tout réindexer » : la note embarquée après l’ouverture de B n’entre pas dans le journal de B', async () => {
    writeReadingNotes(A);
    const svc = readingNotesService();
    const { embedder, entered, release, calls } = heldEmbedder();
    usageJournalService.init(A);
    svc.configure(A);
    const pending = svc.reindexAll(embedder);
    await entered;

    usageJournalService.close();
    usageJournalService.init(B);
    svc.configure(B);
    release();
    await pending;
    usageJournalService.close();

    expect(calls()).toBe(2);
    expect(eventsOf(B)).toEqual([]);
    expect(warnings()).toContain(A);
  });

  it('témoin : sans bascule, les deux appels entrent dans le journal de A, sous sa racine', async () => {
    writeReadingNotes(A);
    const svc = readingNotesService();
    const { embedder, release } = heldEmbedder();
    release();
    usageJournalService.init(A);
    svc.configure(A);
    const report = await svc.index(embedder);
    usageJournalService.close();

    expect(report.indexed).toBe(2);
    expect(eventsOf(A).map((e) => [e.kind, e.workspace])).toEqual([
      ['embedding', A],
      ['embedding', A],
    ]);
  });
});
