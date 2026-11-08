/**
 * Indexation des notes de lecture : bout en bout, vrai store SQLite et vrais
 * fichiers ; seul le fournisseur d'embeddings est simulé. Son compteur
 * d'appels prouve l'incrémental.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable, symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import { ReadingNotesIndexService } from '../reading-notes-index-service.js';
import {
  ReadingNotesStore,
  readingNotesStorePath,
} from '../../../../backend/core/vector-store/ReadingNotesStore.js';
import { READING_NOTES_DIR } from '../../../../backend/core/bibliography/readingNotes.js';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base.js';

interface FakeEmbedder extends EmbeddingProvider {
  calls: number;
  texts: string[];
}

function fakeEmbedder(): FakeEmbedder {
  const provider = {
    calls: 0,
    texts: [] as string[],
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls += 1;
      provider.texts.push(...texts);
      return texts.map((t) => {
        const v = new Array(8).fill(0);
        for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) / 1000;
        return v;
      });
    },
  };
  return provider as unknown as FakeEmbedder;
}

/** Un fournisseur de `dimension` dimensions : 768 pour nomic-embed-text, 1024 pour mxbai. */
function sizedEmbedder(dimension: number): FakeEmbedder {
  const provider = {
    calls: 0,
    texts: [] as string[],
    async embed(texts: string[]): Promise<number[][]> {
      provider.calls += 1;
      provider.texts.push(...texts);
      return texts.map((t) => {
        const v = new Array(dimension).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dimension] += t.charCodeAt(i) / 1000;
        return v;
      });
    },
  };
  return provider as unknown as FakeEmbedder;
}

/** Ollama arrêté : chaque appel échoue. */
const stoppedEmbedder = {
  async embed(): Promise<number[][]> {
    throw new Error('fetch failed (Ollama arrêté)');
  },
} as unknown as EmbeddingProvider;

function writeNote(root: string, file: string, frontMatter: string, body: string): string {
  const dir = path.join(root, READING_NOTES_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  fs.writeFileSync(full, `---\n${frontMatter}\n---\n\n${body}`);
  return full;
}

const BRAUDEL = 'citekey: Braudel_1949\nzotero_key: ABCD1234\ntitle: La Méditerranée\ntags:\n  - chapitre-2';

let tmp = '';
let enabled = true;
let service: ReadingNotesIndexService;

describe('ReadingNotesIndexService — sans base', () => {
  it('reconnaît les fichiers du dossier des notes, et eux seuls', () => {
    const svc = new ReadingNotesIndexService({
      isEnabled: () => true,
      openStore: () => {
        throw new Error('non utilisé');
      },
    });
    svc.configure('/projet');
    expect(svc.isReadingNoteFile('/projet/reading-notes/Braudel_1949.md')).toBe(true);
    expect(svc.isReadingNoteFile('/projet/document.md')).toBe(false);
    expect(svc.isReadingNoteFile('/projet/reading-notes-bis/x.md')).toBe(false);
    expect(svc.isReadingNoteFile('/projet/reading-notes/image.png')).toBe(false);
  });
  it('s’abstient sans consentement quand le fournisseur d’embeddings est distant', async () => {
    const svc = new ReadingNotesIndexService({
      isEnabled: () => true,
      openStore: () => {
        throw new Error('la base ne doit pas être ouverte');
      },
      withheldFrom: () => 'OpenAI',
    });
    svc.configure('/projet');
    const embedder = fakeEmbedder();

    const report = await svc.index(embedder);
    const all = await svc.reindexAll(embedder);

    expect(report).toMatchObject({ indexed: 0, removed: 0, failures: [], withheldFrom: 'OpenAI' });
    expect(all.withheldFrom).toBe('OpenAI');
    // Pas un seul texte de note n'est parti vers le fournisseur.
    expect(embedder.calls).toBe(0);
  });
});

describe.skipIf(!sqliteAvailable)('ReadingNotesIndexService', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-'));
    enabled = true;
    service = new ReadingNotesIndexService({
      isEnabled: () => enabled,
      openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
    });
    service.configure(tmp);
  });

  afterEach(() => {
    service.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('indexe une note avec sa référence, et la retrouve par l’auteur ou l’étiquette', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, '# Braudel — La Méditerranée\n\nTrois temps : la longue durée écrase l’événement.\n');
    const embedder = fakeEmbedder();

    const report = await service.index(embedder);

    expect(report).toMatchObject({ indexed: 1, chunks: 1, failures: [] });
    // L'en-tête part avec l'extrait : sans lui, une note ne dit pas ce qu'elle commente.
    expect(embedder.texts[0]).toMatch(/^Note de lecture sur @Braudel_1949 — La Méditerranée\nÉtiquettes : chapitre-2/);
    const store = service.getSearchStore()!;
    const hits = store.searchLexical('Méditerranée', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk.content).not.toContain('Note de lecture sur');
    // La ligne ramène au fichier, front matter compris.
    const lines = fs.readFileSync(path.join(tmp, READING_NOTES_DIR, 'Braudel_1949.md'), 'utf8').split('\n');
    expect(lines[hits[0].chunk.line - 1]).toContain('Braudel — La Méditerranée');
  });

  it('ne réembarque pas une note inchangée, même renommée', async () => {
    const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    const embedder = fakeEmbedder();
    await service.index(embedder);
    const renamed = path.join(tmp, READING_NOTES_DIR, 'braudel-mediterranee.md');
    fs.renameSync(file, renamed);

    const report = await service.index(embedder);

    expect(embedder.calls).toBe(1);
    expect(report).toMatchObject({ indexed: 0, unchanged: 1, removed: 0 });
    expect(service.getSearchStore()!.getNote('zotero:ABCD1234')?.relativePath).toBe(
      path.join(READING_NOTES_DIR, 'braudel-mediterranee.md')
    );
  });

  it('réindexe quand les étiquettes changent, et retire une note supprimée', async () => {
    const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    await service.index(fakeEmbedder());
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('chapitre-2', 'chapitre-3'));

    expect((await service.index(fakeEmbedder())).indexed).toBe(1);
    expect(service.getSearchStore()!.searchLexical('chapitre-3', 5)).toHaveLength(1);

    fs.rmSync(file);
    expect((await service.index(fakeEmbedder())).removed).toBe(1);
    expect(service.stats()).toMatchObject({ noteCount: 0, chunkCount: 0 });
  });

  it('une note encore vide ne coûte aucun embedding', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, '# Braudel — La Méditerranée\n');
    const embedder = fakeEmbedder();
    const report = await service.index(embedder);
    expect(embedder.calls).toBe(0);
    expect(report).toMatchObject({ indexed: 0, unchanged: 1, chunks: 0 });
  });

  it('un provider absent laisse l’index en l’état, sans empreinte orpheline', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    const broken = {
      async embed(): Promise<number[][]> {
        throw new Error('Ollama éteint');
      },
    } as unknown as EmbeddingProvider;

    const report = await service.index(broken);
    expect(report.failures[0].reason).toMatch(/Ollama éteint/);
    expect(service.stats()?.noteCount).toBe(0);

    // La passe suivante, provider revenu, indexe bien la note.
    expect((await service.index(fakeEmbedder())).indexed).toBe(1);
  });

  it('une note devenue illisible garde son index', async () => {
    const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    await service.index(fakeEmbedder());
    fs.writeFileSync(file, '---\ncitekey: [pas fermé\n---\n\nTexte.\n');

    const report = await service.index(fakeEmbedder());

    expect(report.removed).toBe(0);
    expect(service.stats()?.noteCount).toBe(1);
  });

  it('signale deux fichiers pour la même référence', async () => {
    writeNote(tmp, 'a.md', BRAUDEL, 'Première.\n');
    writeNote(tmp, 'b.md', BRAUDEL, 'Seconde.\n');
    const report = await service.index(fakeEmbedder());
    expect(report.indexed).toBe(1);
    expect(report.failures).toEqual([
      expect.objectContaining({ reason: 'duplicate note for zotero:ABCD1234' }),
    ]);
  });

  it('désactivé, n’indexe rien et n’offre rien à chercher', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    enabled = false;
    const embedder = fakeEmbedder();
    expect((await service.index(embedder)).indexed).toBe(0);
    expect(embedder.calls).toBe(0);
    expect(service.getSearchStore()).toBeNull();
  });

  it('une demande pendant une passe déclenche une passe de plus', async () => {
    const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'Version initiale.\n');
    const embedder = fakeEmbedder();
    const first = service.index(embedder);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('initiale', 'corrigée'));
    const second = service.index(embedder);

    await Promise.all([first, second]);

    expect(service.getSearchStore()!.searchLexical('corrigée', 5)).toHaveLength(1);
  });
});

/**
 * « Tout réindexer » (S04-1-18, S02-1-21). Le bouton vidait l'index avant de savoir si le
 * fournisseur répondait : Ollama arrêté, plus aucune note consultée. Et le store gardait la
 * dimension du premier extrait de la session : après un changement de modèle d'embedding, chaque
 * note échouait sur « dimension mismatch », sur un index déjà vidé.
 */
describe.skipIf(!sqliteAvailable)('ReadingNotesIndexService — tout réindexer', () => {
  const NOTES = [
    ['Braudel_1949.md', BRAUDEL, '# Braudel\n\nLa longue durée écrase l’événement.\n'],
    ['Bloch_1949.md', 'citekey: Bloch_1949\nzotero_key: BLOC0001\ntags: []', '# Bloch\n\nLe métier d’historien.\n'],
    ['Febvre_1942.md', 'citekey: Febvre_1942\nzotero_key: FEBV0001\ntags: []', '# Febvre\n\nL’incroyance au XVIe siècle.\n'],
  ] as const;

  /** Les dimensions des extraits en base, lues par une autre connexion : ce que la recherche verra. */
  function storedDimensions(): number[] {
    const db = new Database(readingNotesStorePath(tmp), { readonly: true });
    try {
      return (db.prepare('SELECT DISTINCT dimension FROM reading_notes_chunks ORDER BY dimension').all() as Array<{
        dimension: number;
      }>).map((r) => r.dimension);
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-tout-'));
    service = new ReadingNotesIndexService({
      isEnabled: () => true,
      openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
    });
    service.configure(tmp);
    for (const [file, front, body] of NOTES) writeNote(tmp, file, front, body);
    expect(await service.index(sizedEmbedder(768))).toMatchObject({ indexed: 3, failures: [] });
  });

  afterEach(() => {
    service.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fournisseur en panne : l’index précédent reste entier et consulté, les échecs sont rendus', async () => {
    const before = service.stats();

    const report = await service.reindexAll(stoppedEmbedder);

    expect(service.stats()).toEqual(before);
    expect(storedDimensions()).toEqual([768]);
    expect(service.getSearchStore()!.searchLexical('Méditerranée Braudel', 5)).not.toEqual([]);
    expect(report.indexed).toBe(0);
    expect(report.failures).toEqual([expect.objectContaining({ reason: expect.stringMatching(/Ollama arrêté/) })]);
    expect(report.abandoned).toMatch(/Ollama arrêté/);
  });

  it('un nombre de vecteurs faux compte comme une panne : rien n’est écrit', async () => {
    const before = service.stats();
    const short = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.slice(1).map(() => new Array(1024).fill(0.5));
      },
    } as unknown as EmbeddingProvider;

    const report = await service.reindexAll(short);

    expect(service.stats()).toEqual(before);
    expect(storedDimensions()).toEqual([768]);
    expect(report.abandoned).toMatch(/0 vectors for 1 chunks/);
  });

  it('le fournisseur tombe en cours de passe : même les notes déjà embarquées restent dans l’ancien index', async () => {
    const working = sizedEmbedder(1024);
    let calls = 0;
    const flaky = {
      async embed(texts: string[]): Promise<number[][]> {
        calls += 1;
        if (calls > 1) throw new Error('fetch failed');
        return working.embed(texts);
      },
    } as unknown as EmbeddingProvider;
    const before = service.stats();

    await service.reindexAll(flaky);

    expect(calls).toBe(2);
    expect(service.stats()).toEqual(before);
    expect(storedDimensions()).toEqual([768]);
  });

  it('changement de modèle (768 → 1024) : toutes les notes sont réembarquées dans la nouvelle dimension', async () => {
    const mxbai = sizedEmbedder(1024);

    const report = await service.reindexAll(mxbai);

    expect(report).toMatchObject({ indexed: 3, failures: [] });
    expect(report.abandoned).toBeUndefined();
    expect(service.stats()).toMatchObject({ noteCount: 3, chunkCount: 3 });
    expect(storedDimensions()).toEqual([1024]);
    // Les sauvegardes suivantes écrivent dans la nouvelle dimension, sans « dimension mismatch ».
    const braudel = path.join(tmp, READING_NOTES_DIR, 'Braudel_1949.md');
    fs.writeFileSync(braudel, fs.readFileSync(braudel, 'utf8').replace('écrase', 'domine'));
    expect(await service.index(mxbai)).toMatchObject({ indexed: 1, failures: [] });
    const [hit] = service.getSearchStore()!.search(new Float32Array(1024).fill(1), 'domine', 1);
    expect(hit.note.citekey).toBe('Braudel_1949');
  });

  it('une note retirée du dossier sort de l’index ; une note illisible garde ses extraits et figure dans les échecs', async () => {
    fs.rmSync(path.join(tmp, READING_NOTES_DIR, 'Febvre_1942.md'));
    fs.writeFileSync(path.join(tmp, READING_NOTES_DIR, 'Bloch_1949.md'), '---\ncitekey: [pas fermé\n---\n\nTexte.\n');

    const report = await service.reindexAll(sizedEmbedder(768));

    expect(report).toMatchObject({ indexed: 1, removed: 1 });
    expect(report.failures.map((f) => f.relativePath)).toEqual([path.join(READING_NOTES_DIR, 'Bloch_1949.md')]);
    const notes = service.getSearchStore()!.listNotes().map((n) => n.citekey);
    expect(notes).toEqual(['Bloch_1949', 'Braudel_1949']);
  });

  it('une passe demandée pendant la réindexation la suit, sans la perdre', async () => {
    const mxbai = sizedEmbedder(1024);
    const all = service.reindexAll(mxbai);
    const next = service.index(mxbai);

    await Promise.all([all, next]);

    expect(storedDimensions()).toEqual([1024]);
    expect(service.stats()?.noteCount).toBe(3);
  });
});

describe.skipIf(!sqliteAvailable)('ReadingNotesIndexService — consentement distant', () => {
  let withheld: string | null = null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-consent-'));
    withheld = null;
    service = new ReadingNotesIndexService({
      isEnabled: () => true,
      openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
      withheldFrom: () => withheld,
    });
    service.configure(tmp);
  });

  afterEach(() => {
    service.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('une réindexation refusée n’efface pas l’index existant', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, '# Braudel\n\nLa longue durée.\n');
    await service.index(fakeEmbedder());
    expect(service.stats()?.noteCount).toBe(1);

    withheld = 'Mistral AI';
    const embedder = fakeEmbedder();
    const report = await service.reindexAll(embedder);

    expect(report.withheldFrom).toBe('Mistral AI');
    expect(embedder.calls).toBe(0);
    expect(service.stats()?.noteCount).toBe(1);
  });

  it('une note modifiée n’est pas envoyée tant que le consentement manque, puis l’est', async () => {
    const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, '# Braudel\n\nLa longue durée.\n');
    await service.index(fakeEmbedder());

    fs.writeFileSync(file, `---\n${BRAUDEL}\n---\n\n# Braudel\n\nTexte confidentiel ajouté.\n`);
    withheld = 'OpenAI';
    const refused = fakeEmbedder();
    await service.index(refused);
    expect(refused.texts.join(' ')).not.toContain('confidentiel');

    withheld = null;
    const allowed = fakeEmbedder();
    const report = await service.index(allowed);
    expect(report.indexed).toBe(1);
    expect(allowed.texts.join(' ')).toContain('confidentiel');
  });

  describe.skipIf(!symlinkAvailable)('note en lien symbolique', () => {
    const SECRET = 'SECRETHORSPROJET';
    let outside = '';

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-dehors-'));
      fs.writeFileSync(path.join(outside, 'journal.md'), `---\n${BRAUDEL}\n---\n\n${SECRET} : texte privé.\n`);
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it('hors du projet : n’atteint ni le fournisseur ni la base, et le rapport le dit', async () => {
      fs.mkdirSync(path.join(tmp, READING_NOTES_DIR));
      fs.symlinkSync(path.join(outside, 'journal.md'), path.join(tmp, READING_NOTES_DIR, 'Braudel_1949.md'));
      const embedder = fakeEmbedder();

      const report = await service.index(embedder);

      expect(embedder.calls).toBe(0);
      expect(report.indexed).toBe(0);
      expect(report.failures.map((f) => f.relativePath)).toEqual([path.join(READING_NOTES_DIR, 'Braudel_1949.md')]);
      expect(service.getSearchStore()!.stats().noteCount).toBe(0);
    });

    it('déjà indexée par le lien : la passe suivante retire ses extraits', async () => {
      const file = writeNote(tmp, 'Braudel_1949.md', BRAUDEL, `${SECRET} : texte privé.\n`);
      await service.index(fakeEmbedder());
      const store = service.getSearchStore()!;
      expect(store.stats().noteCount).toBe(1);
      expect(store.searchLexical(SECRET, 5).length).toBeGreaterThan(0);

      fs.rmSync(file);
      fs.symlinkSync(path.join(outside, 'journal.md'), file);
      const report = await service.index(fakeEmbedder());

      expect(report.removed).toBe(1);
      expect(store.stats()).toMatchObject({ noteCount: 0, chunkCount: 0 });
      expect(store.searchLexical(SECRET, 5)).toEqual([]);
    });

    it('un lien interne reste indexé', async () => {
      fs.mkdirSync(path.join(tmp, READING_NOTES_DIR));
      fs.writeFileSync(path.join(tmp, 'brouillon.md'), `---\n${BRAUDEL}\n---\n\nLa longue durée.\n`);
      fs.symlinkSync(path.join(tmp, 'brouillon.md'), path.join(tmp, READING_NOTES_DIR, 'Braudel_1949.md'));

      const report = await service.index(fakeEmbedder());

      expect(report.indexed).toBe(1);
      expect(report.failures).toEqual([]);
    });
  });
});

/**
 * D18 : `.cliodeck` lié hors du projet. La passe d'indexation ouvrait `brain.db` à travers le lien,
 * et les notes de l'auteur partaient dans la base d'un autre projet.
 */
describe.skipIf(!sqliteAvailable || !symlinkAvailable)('ReadingNotesIndexService — .cliodeck lié hors du projet', () => {
  let outside = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-rnindex-ailleurs-'));
    service = new ReadingNotesIndexService({
      isEnabled: () => true,
      openStore: (root) => new ReadingNotesStore({ dbPath: readingNotesStorePath(root) }),
    });
    service.configure(tmp);
  });

  afterEach(() => {
    service.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('ni base ouverte, ni fournisseur appelé, rien à l’autre bout', async () => {
    writeNote(tmp, 'Braudel_1949.md', BRAUDEL, 'La longue durée.\n');
    fs.symlinkSync(outside, path.join(tmp, '.cliodeck'));
    const embedder = fakeEmbedder();

    await service.index(embedder);
    await service.reindexAll(embedder);

    expect(service.stats()).toBeNull();
    expect(service.getSearchStore()).toBeNull();
    expect(embedder.calls).toBe(0);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
