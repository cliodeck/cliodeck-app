/**
 * Indexation du manuscrit : intégration bout en bout (item 25 des audits).
 *
 * On exerce le vrai service contre un vrai projet sur disque et un vrai
 * store SQLite ; seul le fournisseur d'embeddings est simulé — appeler
 * Ollama depuis une suite de tests la rendrait lente et dépendante d'un
 * démon. Le simulacre compte ses appels : c'est ce compteur qui prouve
 * l'incrémental, pas une assertion sur un log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sqliteAvailable, symlinkAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
import { manuscriptIndexService } from '../manuscript-index-service.js';
import { ManuscriptStore } from '../../../../backend/core/vector-store/ManuscriptStore.js';
import type { EmbeddingProvider } from '../../../../backend/core/llm/providers/base.js';

let tmp = '';

/**
 * Embeddings déterministes : un vecteur de 8 dimensions dérivé du texte.
 * Deux textes proches ne le sont pas « sémantiquement », mais la recherche
 * exacte d'un vecteur connu reste vérifiable.
 */
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

interface HeldEmbedder extends FakeEmbedder {
  /** Résolue quand la passe est entrée dans l'embedding : le fichier est déjà lu. */
  entered: Promise<void>;
  release: () => void;
}

/** Un fournisseur dont le premier appel attend `release()` : la passe reste en vol le temps voulu. */
function heldEmbedder(): HeldEmbedder {
  const provider = fakeEmbedder();
  const embed = provider.embed.bind(provider);
  let enter = (): void => undefined;
  let release = (): void => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = true;
  return Object.assign(provider, {
    entered,
    release,
    async embed(texts: string[]): Promise<number[][]> {
      if (held) {
        held = false;
        enter();
        await released;
      }
      return embed(texts);
    },
  });
}

function writeArticle(root: string, body: string): void {
  fs.writeFileSync(
    path.join(root, 'project.json'),
    JSON.stringify({ name: 'Article', path: root, type: 'article', createdAt: '', updatedAt: '' })
  );
  fs.writeFileSync(path.join(root, 'document.md'), `# Article\n\n${body}\n`);
}

function writeProject(
  root: string,
  chapters: Array<{ file: string; title: string; body: string }>
): void {
  fs.mkdirSync(path.join(root, 'chapters'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'project.json'),
    JSON.stringify({
      id: 'test-book',
      name: 'Danzig',
      path: root,
      type: 'book',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chapters: chapters.map((c, i) => ({
        id: `c${i + 1}`,
        title: c.title,
        filePath: `chapters/${c.file}`,
        order: i,
        kind: 'chapter',
      })),
    })
  );
  for (const c of chapters) {
    fs.writeFileSync(path.join(root, 'chapters', c.file), c.body);
  }
}

describe.skipIf(!sqliteAvailable)('manuscriptIndexService', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-'));
  });

  afterEach(() => {
    manuscriptIndexService.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('indexe les chapitres d’un livre et les rend interrogeables', async () => {
    writeProject(tmp, [
      {
        file: '01.md',
        title: 'Ouverture',
        body: '# Ouverture\n\nLe port de Danzig est disputé depuis 1919.\n',
      },
      {
        file: '02.md',
        title: 'Le Volkstag',
        body: '# Le Volkstag\n\nLes élections de 1932 marquent une rupture.\n',
      },
    ]);

    manuscriptIndexService.configure(tmp);
    const embedder = fakeEmbedder();
    const report = await manuscriptIndexService.index(embedder);

    expect(report.indexed).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.chunks).toBeGreaterThanOrEqual(2);

    const store = new ManuscriptStore({
      dbPath: path.join(tmp, '.cliodeck', 'brain.db'),
    });
    try {
      expect(store.stats().chapterCount).toBe(2);
      // Le texte de l'auteur est retrouvable, rattaché à son chapitre.
      const hits = store.searchLexical('Danzig', 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].chapter.title).toBe('Ouverture');
      expect(hits[0].chapter.relativePath).toBe('chapters/01.md');
    } finally {
      store.close();
    }
  });

  it('n’appelle plus le fournisseur quand rien n’a changé', async () => {
    writeProject(tmp, [
      { file: '01.md', title: 'Un', body: '# Un\n\nTexte stable.\n' },
    ]);
    manuscriptIndexService.configure(tmp);

    const first = fakeEmbedder();
    const r1 = await manuscriptIndexService.index(first);
    expect(r1.indexed).toBe(1);
    expect(first.calls).toBeGreaterThan(0);

    // Seconde passe, contenu identique : aucun embedding — c'est ce qui
    // rend un manuscrit de 400 000 mots tenable à chaque sauvegarde.
    const second = fakeEmbedder();
    const r2 = await manuscriptIndexService.index(second);
    expect(second.calls).toBe(0);
    expect(r2.indexed).toBe(0);
    expect(r2.unchanged).toBe(1);
  });

  it('réindexe le seul chapitre modifié', async () => {
    writeProject(tmp, [
      { file: '01.md', title: 'Un', body: '# Un\n\nAlpha.\n' },
      { file: '02.md', title: 'Deux', body: '# Deux\n\nBeta.\n' },
    ]);
    manuscriptIndexService.configure(tmp);
    await manuscriptIndexService.index(fakeEmbedder());

    fs.writeFileSync(
      path.join(tmp, 'chapters', '02.md'),
      '# Deux\n\nBeta revu et corrigé.\n'
    );

    const embedder = fakeEmbedder();
    const report = await manuscriptIndexService.index(embedder);
    expect(report.indexed).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(embedder.texts.join(' ')).toContain('revu et corrigé');
    expect(embedder.texts.join(' ')).not.toContain('Alpha');
  });

  it('retire de l’index un chapitre sorti du manifeste', async () => {
    writeProject(tmp, [
      { file: '01.md', title: 'Un', body: '# Un\n\nAlpha.\n' },
      { file: '02.md', title: 'Deux', body: '# Deux\n\nBeta.\n' },
    ]);
    manuscriptIndexService.configure(tmp);
    await manuscriptIndexService.index(fakeEmbedder());

    // L'auteur détache le chapitre 2 (le fichier reste sur le disque).
    writeProject(tmp, [{ file: '01.md', title: 'Un', body: '# Un\n\nAlpha.\n' }]);

    const report = await manuscriptIndexService.index(fakeEmbedder());
    expect(report.removed).toBe(1);

    const store = new ManuscriptStore({
      dbPath: path.join(tmp, '.cliodeck', 'brain.db'),
    });
    try {
      expect(store.stats().chapterCount).toBe(1);
      // L'assistant ne doit plus citer un texte que l'auteur a détaché.
      expect(store.searchLexical('Beta', 5)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('indexe document.md pour un projet sans manifeste', async () => {
    fs.writeFileSync(
      path.join(tmp, 'project.json'),
      JSON.stringify({ name: 'Article', path: tmp, type: 'article', createdAt: '', updatedAt: '' })
    );
    fs.writeFileSync(
      path.join(tmp, 'document.md'),
      '# Article\n\nUne analyse du port franc.\n'
    );

    manuscriptIndexService.configure(tmp);
    const report = await manuscriptIndexService.index(fakeEmbedder());
    expect(report.indexed).toBe(1);
  });

  it('ne fait rien, sans échouer, quand le projet n’a pas de manuscrit', async () => {
    fs.writeFileSync(
      path.join(tmp, 'project.json'),
      JSON.stringify({ name: 'Vide', path: tmp, type: 'article', createdAt: '', updatedAt: '' })
    );
    manuscriptIndexService.configure(tmp);
    const report = await manuscriptIndexService.index(fakeEmbedder());
    expect(report.indexed).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('un fournisseur en panne laisse l’index intact et ne jette pas', async () => {
    writeProject(tmp, [
      { file: '01.md', title: 'Un', body: '# Un\n\nAlpha.\n' },
    ]);
    manuscriptIndexService.configure(tmp);

    const broken: EmbeddingProvider = {
      embed: async () => {
        throw new Error('Ollama unreachable');
      },
    } as never;

    // Best-effort : l'écriture de l'auteur ne doit jamais dépendre de ça.
    const report = await manuscriptIndexService.index(broken);
    expect(report.indexed).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].reason).toMatch(/embedding failed/i);
  });

  /**
   * S02-2-3 : une sauvegarde arrivée pendant une passe rendait la passe en cours, qui avait déjà
   * lu le fichier. Le nouveau paragraphe restait hors de l'index jusqu'à la sauvegarde suivante.
   */
  describe('demande pendant une passe', () => {
    let other = '';

    afterEach(() => {
      if (other) fs.rmSync(other, { recursive: true, force: true });
      other = '';
    });

    it('une sauvegarde pendant l’embedding est indexée : une passe de plus suit, une seule', async () => {
      writeArticle(tmp, 'Le port de Vichy.');
      manuscriptIndexService.configure(tmp);
      const embedder = heldEmbedder();

      const first = manuscriptIndexService.index(embedder);
      await embedder.entered;
      writeArticle(tmp, 'Le port de Danzig.');
      // Trois sauvegardes rapprochées : une passe de plus, pas trois.
      const later = [1, 2, 3].map(() => manuscriptIndexService.index(embedder));
      embedder.release();
      const reports = await Promise.all([first, ...later]);

      // La dernière passe est celle qui a embarqué la nouvelle version : aucune autre ne la suit.
      for (const report of reports) expect(report).toMatchObject({ indexed: 1, failures: [] });
      expect(manuscriptIndexService.stats()?.lastReport).toMatchObject({ indexed: 1 });
      const store = new ManuscriptStore({ dbPath: path.join(tmp, '.cliodeck', 'brain.db') });
      try {
        expect(store.searchLexical('Danzig', 5)).toHaveLength(1);
        expect(store.searchLexical('Vichy', 5)).toEqual([]);
      } finally {
        store.close();
      }
    });

    it('une demande faite dans le projet suivant, pendant la passe du précédent, est servie', async () => {
      other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-b-'));
      writeArticle(tmp, 'Le port de Vichy.');
      writeArticle(other, 'Le port de Gdynia.');
      manuscriptIndexService.configure(tmp);
      const embedder = heldEmbedder();

      const first = manuscriptIndexService.index(embedder);
      await embedder.entered;
      manuscriptIndexService.configure(other);
      const second = manuscriptIndexService.index(embedder);
      embedder.release();
      await Promise.all([first, second]);

      const store = new ManuscriptStore({ dbPath: path.join(other, '.cliodeck', 'brain.db') });
      try {
        expect(store.searchLexical('Gdynia', 5)).toHaveLength(1);
        expect(store.searchLexical('Vichy', 5)).toEqual([]);
      } finally {
        store.close();
      }
    });

    it('la purge qui clôt l’ouverture du projet suivant ne fait pas perdre sa demande', async () => {
      // `project:load` finit par `configure` puis `purgeOutside` (project-handlers). Celle-ci ouvre
      // la base pour l'occasion et la referme : la relance demandée entre-temps doit survivre.
      other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-b-'));
      writeArticle(tmp, 'Le port de Vichy.');
      writeArticle(other, 'Le port de Gdynia.');
      manuscriptIndexService.configure(tmp);
      const embedder = heldEmbedder();

      const first = manuscriptIndexService.index(embedder);
      await embedder.entered;
      manuscriptIndexService.configure(other);
      const second = manuscriptIndexService.index(embedder);
      manuscriptIndexService.configure(other);
      expect(manuscriptIndexService.purgeOutside()).toBe(0);
      embedder.release();
      await Promise.all([first, second]);

      const store = new ManuscriptStore({ dbPath: path.join(other, '.cliodeck', 'brain.db') });
      try {
        expect(store.searchLexical('Gdynia', 5)).toHaveLength(1);
      } finally {
        store.close();
      }
    });

    it('témoin : une passe qui jette laisse « (passe) » au compte rendu et rejette', async () => {
      writeArticle(tmp, 'Le port de Vichy.');
      manuscriptIndexService.configure(tmp);
      const listChapters = vi
        .spyOn(ManuscriptStore.prototype, 'listChapters')
        .mockImplementationOnce(() => {
          throw new Error('database is locked');
        });
      try {
        await expect(manuscriptIndexService.index(fakeEmbedder())).rejects.toThrow(/locked/);
        expect(manuscriptIndexService.stats()?.lastReport?.failures).toEqual([
          { relativePath: '(passe)', reason: 'database is locked' },
        ]);
      } finally {
        listChapters.mockRestore();
      }
    });

    it('une passe qui jette ne fait pas perdre la demande arrivée pendant', async () => {
      writeArticle(tmp, 'Le port de Vichy.');
      manuscriptIndexService.configure(tmp);
      const embedder = heldEmbedder();
      const listChapters = vi
        .spyOn(ManuscriptStore.prototype, 'listChapters')
        .mockImplementationOnce(() => {
          throw new Error('database is locked');
        });
      try {
        const first = manuscriptIndexService.index(embedder);
        await embedder.entered;
        writeArticle(tmp, 'Le port de Danzig.');
        const second = manuscriptIndexService.index(embedder);
        embedder.release();

        // Tous reçoivent la dernière passe, réussie.
        for (const report of await Promise.all([first, second])) {
          expect(report).toMatchObject({ indexed: 1, failures: [] });
        }
        expect(manuscriptIndexService.stats()?.lastReport).toMatchObject({ indexed: 1, failures: [] });
      } finally {
        listChapters.mockRestore();
      }
      const store = new ManuscriptStore({ dbPath: path.join(tmp, '.cliodeck', 'brain.db') });
      try {
        expect(store.searchLexical('Danzig', 5)).toHaveLength(1);
      } finally {
        store.close();
      }
    });

    it('une relance demandée dans un projet ne tourne pas dans le suivant', async () => {
      other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-b-'));
      writeArticle(tmp, 'Le port de Vichy.');
      writeArticle(other, 'Le port de Gdynia.');
      manuscriptIndexService.configure(tmp);
      const embedder = heldEmbedder();

      const first = manuscriptIndexService.index(embedder);
      await embedder.entered;
      const again = manuscriptIndexService.index(embedder);
      manuscriptIndexService.configure(other);
      embedder.release();
      await Promise.all([first, again]);

      // Personne n'a rien demandé dans B : ni lu, ni envoyé au fournisseur, ni base ouverte.
      expect(embedder.texts.join('\n')).not.toContain('Gdynia');
      expect(fs.existsSync(path.join(other, '.cliodeck', 'brain.db'))).toBe(false);
    });
  });

  /**
   * S02-1-13 : la passe prenait son store après `listPieces`, par `getStore()`, qui relit le projet
   * courant. Un autre projet ouvert pendant cette lecture recevait le texte du premier, et la purge
   * finale y retirait ce que le premier n'avait pas. La passe prend désormais le store de son
   * projet avant toute attente, et s'arrête dès que le projet a changé, sans écrire ni purger.
   */
  describe('un autre projet ouvert pendant la passe', () => {
    let other = '';

    beforeEach(() => {
      other = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-b-'));
    });

    afterEach(() => {
      fs.rmSync(other, { recursive: true, force: true });
      other = '';
    });

    /** Ce qu'une autre connexion lit dans le brain.db d'un projet : ce que la recherche y verra. */
    function indexOf(root: string): { chapters: string[]; hits: (word: string) => number } {
      const store = new ManuscriptStore({ dbPath: path.join(root, '.cliodeck', 'brain.db') });
      try {
        const chapters = store.listChapters().map((c) => c.relativePath).sort();
        const texts = new Map<string, number>();
        for (const word of ['Dantzig', 'Gdynia', 'Sopot', 'Lyon', 'revu']) {
          texts.set(word, store.searchLexical(word, 10).length);
        }
        return { chapters, hits: (word) => texts.get(word) ?? 0 };
      } finally {
        store.close();
      }
    }

    const BOOK_A = [
      { file: '01.md', title: 'Dantzig', body: '# Dantzig\n\nTexte du projet A sur Dantzig.\n' },
      { file: '02.md', title: 'Gdynia', body: '# Gdynia\n\nTexte du projet A sur Gdynia.\n' },
      { file: '03.md', title: 'Sopot', body: '# Sopot\n\nTexte du projet A sur Sopot.\n' },
    ];
    const BOOK_B = [{ file: '01.md', title: 'Lyon', body: '# Lyon\n\nTexte du projet B sur Lyon.\n' }];
    const ALL_A = ['chapters/01.md', 'chapters/02.md', 'chapters/03.md'];

    async function indexed(root: string, chapters: typeof BOOK_A): Promise<void> {
      writeProject(root, chapters);
      manuscriptIndexService.configure(root);
      await manuscriptIndexService.index(fakeEmbedder());
    }

    it('B ouvert pendant la lecture du manifeste de A : rien de A n’entre dans B, rien de B n’en sort', async () => {
      await indexed(other, BOOK_B);
      writeProject(tmp, BOOK_A);
      manuscriptIndexService.configure(tmp);
      const embedder = fakeEmbedder();

      const pass = manuscriptIndexService.index(embedder);
      manuscriptIndexService.configure(other); // pendant `listPieces`
      const report = await pass;

      const b = indexOf(other);
      expect(b.hits('Dantzig')).toBe(0);
      expect(b.hits('Lyon')).toBe(1);
      expect(b.chapters).toEqual(['chapters/01.md']);
      expect(report.abandoned).toBe('project-changed');
      expect(embedder.calls).toBe(0);
      expect(indexOf(tmp).chapters).toEqual([]);
      // La passe de A n'a pas ouvert la base de B : le service n'en tient aucune.
      expect(manuscriptIndexService.stats()).toBeNull();
    });

    it('B ouvert pendant la boucle de A : la passe s’arrête, et sa purge n’a pas lieu', async () => {
      await indexed(tmp, BOOK_A);
      writeProject(other, BOOK_B);
      // Le premier chapitre de A change : la passe s'arrête à son embedding.
      fs.writeFileSync(path.join(tmp, 'chapters', '01.md'), '# Dantzig\n\nTexte du projet A sur Dantzig, revu.\n');
      const embedder = heldEmbedder();

      const pass = manuscriptIndexService.index(embedder);
      await embedder.entered;
      manuscriptIndexService.configure(other);
      embedder.release();
      const report = await pass;

      // Aucun chapitre de A retiré : la purge d'une passe interrompue n'a vu qu'une partie du livre.
      expect(indexOf(tmp).chapters).toEqual(ALL_A);
      // Et rien de plus ne s'écrit après la bascule : le chapitre revu le sera à la passe suivante de A.
      expect(indexOf(tmp).hits('revu')).toBe(0);
      expect(report.abandoned).toBe('project-changed');
      expect(fs.existsSync(path.join(other, '.cliodeck', 'brain.db'))).toBe(false);
    });

    it('A → B → A pendant la boucle : rien dans B, aucun chapitre de A purgé, la passe de la première ouverture s’arrête', async () => {
      await indexed(other, BOOK_B);
      await indexed(tmp, BOOK_A);
      fs.writeFileSync(path.join(tmp, 'chapters', '01.md'), '# Dantzig\n\nTexte du projet A sur Dantzig, revu.\n');
      const embedder = heldEmbedder();

      const pass = manuscriptIndexService.index(embedder);
      await embedder.entered;
      manuscriptIndexService.configure(other);
      manuscriptIndexService.configure(tmp);
      embedder.release();
      const report = await pass;

      const b = indexOf(other);
      expect(b.hits('Dantzig')).toBe(0);
      expect(b.chapters).toEqual(['chapters/01.md']);
      expect(b.hits('Lyon')).toBe(1);
      expect(indexOf(tmp).chapters).toEqual(ALL_A);
      expect(report.abandoned).toBe('project-changed');

      // La passe suivante de A, elle, embarque le chapitre revu.
      expect(await manuscriptIndexService.index(fakeEmbedder())).toMatchObject({ indexed: 1, unchanged: 2, removed: 0 });
      expect(indexOf(tmp).hits('revu')).toBe(1);
    });

    it('A → B → A pendant la lecture du manifeste : rien n’est écrit, ni dans A ni dans B', async () => {
      await indexed(other, BOOK_B);
      await indexed(tmp, BOOK_A);
      fs.writeFileSync(path.join(tmp, 'chapters', '01.md'), '# Dantzig\n\nTexte du projet A sur Dantzig, revu.\n');
      const embedder = fakeEmbedder();

      const pass = manuscriptIndexService.index(embedder);
      manuscriptIndexService.configure(other);
      manuscriptIndexService.configure(tmp);
      const report = await pass;

      expect(report.abandoned).toBe('project-changed');
      expect(embedder.calls).toBe(0);
      expect(indexOf(tmp).chapters).toEqual(ALL_A);
      expect(indexOf(tmp).hits('revu')).toBe(0);
      expect(indexOf(other).chapters).toEqual(['chapters/01.md']);
    });

    it('la section des réglages de B ne montre pas le compte rendu de la passe de A', async () => {
      writeProject(tmp, BOOK_A);
      writeProject(other, BOOK_B);
      manuscriptIndexService.configure(tmp);
      const inA = heldEmbedder();
      const passA = manuscriptIndexService.index(inA);
      await inA.entered;
      manuscriptIndexService.configure(other);
      // Un enregistrement dans B pendant la passe de A : la passe de B la suit.
      const inB = heldEmbedder();
      const passB = manuscriptIndexService.index(inB);
      inA.release();
      await inB.entered;

      // La passe de A est finie, celle de B en cours : ce que lit la section des réglages de B.
      const duringB = manuscriptIndexService.stats()?.lastReport;
      inB.release();
      await Promise.all([passA, passB]);

      expect(duringB).toBeNull();
      const last = manuscriptIndexService.stats()?.lastReport;
      expect(last).toMatchObject({ indexed: 1, removed: 0, failures: [] });
      expect(last?.abandoned).toBeUndefined();
    });
  });

  /**
   * Décision Q16 : un chapitre lié hors du projet n'est ni lu ni indexé. Et s'il l'a été
   * avant, ses extraits sortent de `brain.db` à la passe suivante : sinon il continue
   * d'alimenter les prompts, et rien n'est gagné.
   */
  describe.skipIf(!symlinkAvailable)('liens symboliques', () => {
    const SECRET = 'SECRETHORSPROJET';
    let outside = '';

    /** Le contenu réel des tables, pas ce qu'en dit le store. */
    function tables(root = tmp): { chapters: number; chunks: number; fts: number; text: string } {
      const db = new Database(path.join(root, '.cliodeck', 'brain.db'), { readonly: true });
      try {
        const count = (table: string) =>
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        const rows = db.prepare('SELECT content FROM manuscript_chunks').all() as Array<{ content: string }>;
        return {
          chapters: count('manuscript_chapters'),
          chunks: count('manuscript_chunks'),
          fts: count('manuscript_chunks_fts'),
          text: rows.map((r) => r.content).join('\n'),
        };
      } finally {
        db.close();
      }
    }

    beforeEach(() => {
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-dehors-'));
      fs.writeFileSync(path.join(outside, 'journal.md'), `# Journal\n\n${SECRET} : texte privé.\n`);
    });

    afterEach(() => {
      fs.rmSync(outside, { recursive: true, force: true });
    });

    const CHAPTERS = [
      { file: '01.md', title: 'Un', body: '# Un\n\nLe port de Danzig.\n' },
      { file: '02.md', title: 'Annexe', body: '# Annexe\n\nProvisoire.\n' },
    ];

    function linkOut(file: string): void {
      const target = path.join(tmp, 'chapters', file);
      fs.rmSync(target, { force: true });
      fs.symlinkSync(path.join(outside, 'journal.md'), target);
    }

    it('un chapitre lié hors du projet n’atteint ni le fournisseur ni la base', async () => {
      writeProject(tmp, CHAPTERS);
      linkOut('02.md');
      manuscriptIndexService.configure(tmp);
      const embedder = fakeEmbedder();

      const report = await manuscriptIndexService.index(embedder);

      expect(report.indexed).toBe(1);
      expect(embedder.texts.join('\n')).not.toContain(SECRET);
      expect(tables().text).not.toContain(SECRET);
    });

    it('déjà indexé par le lien : la passe suivante retire ses extraits', async () => {
      // État d'avant ce correctif : le chapitre est un fichier ordinaire au moment de
      // l'indexation, puis un lien. Le contenu indexé joue le contenu du fichier visé.
      writeProject(tmp, [CHAPTERS[0], { file: '02.md', title: 'Annexe', body: `# Annexe\n\n${SECRET} : texte privé.\n` }]);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      expect(tables().text).toContain(SECRET);
      expect(tables().chapters).toBe(2);

      linkOut('02.md');
      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.removed).toBe(1);
      const after = tables();
      expect(after.chapters).toBe(1);
      expect(after.text).not.toContain(SECRET);
      expect(after.fts).toBe(after.chunks);
      const store = new ManuscriptStore({ dbPath: path.join(tmp, '.cliodeck', 'brain.db') });
      try {
        expect(store.searchLexical(SECRET, 5)).toEqual([]);
      } finally {
        store.close();
      }
    });

    it('le seul chapitre du livre, déjà indexé : retiré quand même', async () => {
      // Sans pièce à indexer, la passe s'arrêtait avant la purge.
      writeProject(tmp, [{ file: '01.md', title: 'Seul', body: `# Seul\n\n${SECRET} : texte privé.\n` }]);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      expect(tables().chunks).toBeGreaterThan(0);

      linkOut('01.md');
      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.removed).toBe(1);
      expect(tables()).toMatchObject({ chapters: 0, chunks: 0, fts: 0 });
    });

    it('un document.md lié hors du projet : pas indexé, et retiré s’il l’était', async () => {
      const documentMd = path.join(tmp, 'document.md');
      fs.writeFileSync(documentMd, `# Article\n\n${SECRET} : texte privé.\n`);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      expect(tables().text).toContain(SECRET);

      fs.rmSync(documentMd);
      fs.symlinkSync(path.join(outside, 'journal.md'), documentMd);
      const embedder = fakeEmbedder();
      const report = await manuscriptIndexService.index(embedder);

      expect(embedder.calls).toBe(0);
      expect(report.removed).toBe(1);
      expect(tables()).toMatchObject({ chapters: 0, chunks: 0, fts: 0 });
    });

    it('un document.md devenu lien cassé vers l’extérieur : retiré aussi', async () => {
      const documentMd = path.join(tmp, 'document.md');
      fs.writeFileSync(documentMd, `# Article\n\n${SECRET} : texte privé.\n`);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      expect(tables().text).toContain(SECRET);

      fs.rmSync(documentMd);
      fs.symlinkSync(path.join(outside, 'pas-encore.md'), documentMd);
      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.removed).toBe(1);
      expect(tables()).toMatchObject({ chapters: 0, chunks: 0, fts: 0 });
    });

    it('un slides.md lié hors du projet : pas indexé non plus', async () => {
      fs.symlinkSync(path.join(outside, 'journal.md'), path.join(tmp, 'slides.md'));
      manuscriptIndexService.configure(tmp);
      const embedder = fakeEmbedder();

      await manuscriptIndexService.index(embedder);

      expect(embedder.texts.join('\n')).not.toContain(SECRET);
    });

    it('un lien interne reste indexé', async () => {
      writeProject(tmp, [CHAPTERS[0]]);
      fs.symlinkSync('01.md', path.join(tmp, 'chapters', 'copie.md'));
      fs.writeFileSync(
        path.join(tmp, 'project.json'),
        JSON.stringify({
          type: 'book',
          chapters: [{ id: 'c', title: 'Copie', filePath: 'chapters/copie.md', order: 0, kind: 'chapter' }],
        })
      );
      manuscriptIndexService.configure(tmp);

      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.indexed).toBe(1);
      expect(tables().text).toContain('Danzig');
    });

    it('un projet ouvert par un chemin en lien garde tout son index', async () => {
      writeProject(tmp, CHAPTERS);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      manuscriptIndexService.clear();

      const alias = `${tmp}-alias`;
      fs.symlinkSync(tmp, alias);
      try {
        manuscriptIndexService.configure(alias);
        const embedder = fakeEmbedder();
        const report = await manuscriptIndexService.index(embedder);

        expect(report).toMatchObject({ indexed: 0, unchanged: 2, removed: 0 });
        expect(embedder.calls).toBe(0);
      } finally {
        manuscriptIndexService.clear();
        fs.rmSync(alias, { force: true });
      }
    });

    it('témoin : un livre dont tous les chapitres manquent garde son index', async () => {
      // `chapters/` déplacé, changement de branche : au retour du dossier, rien à réembarquer.
      writeProject(tmp, CHAPTERS);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      expect(tables().chapters).toBe(2);

      fs.renameSync(path.join(tmp, 'chapters'), path.join(tmp, 'chapters-ailleurs'));
      const absent = await manuscriptIndexService.index(fakeEmbedder());

      expect(absent.removed).toBe(0);
      expect(tables().chapters).toBe(2);

      fs.renameSync(path.join(tmp, 'chapters-ailleurs'), path.join(tmp, 'chapters'));
      const embedder = fakeEmbedder();
      const back = await manuscriptIndexService.index(embedder);

      expect(back).toMatchObject({ indexed: 0, unchanged: 2, removed: 0 });
      expect(embedder.calls).toBe(0);
    });

    it('tous les chapitres manquent et l’un sort du projet : lui seul quitte l’index', async () => {
      writeProject(tmp, CHAPTERS);
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());

      fs.rmSync(path.join(tmp, 'chapters', '01.md'));
      linkOut('02.md');
      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.removed).toBe(1);
      expect(tables().chapters).toBe(1);
      expect(tables().text).toContain('Danzig');
    });

    /**
     * À l'ouverture du projet : la passe n'arrive qu'à la première sauvegarde, et une
     * question posée avant enverrait l'extrait au modèle.
     */
    describe('purgeOutside', () => {
      it('retire le chapitre devenu lien sortant, sans fournisseur ni passe', async () => {
        writeProject(tmp, [CHAPTERS[0], { file: '02.md', title: 'Annexe', body: `# Annexe\n\n${SECRET} : texte privé.\n` }]);
        manuscriptIndexService.configure(tmp);
        await manuscriptIndexService.index(fakeEmbedder());
        expect(tables().text).toContain(SECRET);
        linkOut('02.md');

        expect(manuscriptIndexService.purgeOutside()).toBe(1);

        const after = tables();
        expect(after.chapters).toBe(1);
        expect(after.text).not.toContain(SECRET);
        expect(after.text).toContain('Danzig');
        expect(after.fts).toBe(after.chunks);
      });

      it('le seul chapitre du livre : retiré aussi', async () => {
        writeProject(tmp, [{ file: '01.md', title: 'Seul', body: `# Seul\n\n${SECRET} : texte privé.\n` }]);
        manuscriptIndexService.configure(tmp);
        await manuscriptIndexService.index(fakeEmbedder());
        linkOut('01.md');

        expect(manuscriptIndexService.purgeOutside()).toBe(1);
        expect(tables()).toMatchObject({ chapters: 0, chunks: 0, fts: 0 });
      });

      it('témoin : ne touche ni à un chapitre momentanément absent, ni à un lien interne', async () => {
        writeProject(tmp, CHAPTERS);
        manuscriptIndexService.configure(tmp);
        await manuscriptIndexService.index(fakeEmbedder());
        fs.rmSync(path.join(tmp, 'chapters', '01.md'));
        fs.rmSync(path.join(tmp, 'chapters', '02.md'));
        fs.writeFileSync(path.join(tmp, 'relie.md'), '# Relié\n');
        fs.symlinkSync(path.join('..', 'relie.md'), path.join(tmp, 'chapters', '02.md'));

        expect(manuscriptIndexService.purgeOutside()).toBe(0);
        expect(tables().chapters).toBe(2);
      });

      it('témoin : un projet ouvert par un chemin en lien ne perd rien', async () => {
        writeProject(tmp, CHAPTERS);
        manuscriptIndexService.configure(tmp);
        await manuscriptIndexService.index(fakeEmbedder());
        manuscriptIndexService.clear();

        const alias = `${tmp}-alias`;
        fs.symlinkSync(tmp, alias);
        try {
          manuscriptIndexService.configure(alias);
          expect(manuscriptIndexService.purgeOutside()).toBe(0);
          expect(tables().chapters).toBe(2);
        } finally {
          manuscriptIndexService.clear();
          fs.rmSync(alias, { force: true });
        }
      });

      it('ne garde pas la base ouverte pour autant, sauf si elle l’était déjà', async () => {
        writeProject(tmp, CHAPTERS);
        manuscriptIndexService.configure(tmp);
        await manuscriptIndexService.index(fakeEmbedder());
        expect(manuscriptIndexService.stats()).not.toBeNull();

        manuscriptIndexService.purgeOutside();
        expect(manuscriptIndexService.stats()).not.toBeNull();

        manuscriptIndexService.clear();
        manuscriptIndexService.configure(tmp);
        manuscriptIndexService.purgeOutside();
        expect(manuscriptIndexService.stats()).toBeNull();
      });

      it('sans projet rattaché : rien à faire, rien ne jette', () => {
        manuscriptIndexService.clear();
        expect(manuscriptIndexService.purgeOutside()).toBe(0);
      });
    });

    it('témoin : un article sans document garde l’index qu’il a, comme avant', async () => {
      const documentMd = path.join(tmp, 'document.md');
      fs.writeFileSync(documentMd, '# Article\n\nDu texte.\n');
      manuscriptIndexService.configure(tmp);
      await manuscriptIndexService.index(fakeEmbedder());
      fs.rmSync(documentMd);

      const report = await manuscriptIndexService.index(fakeEmbedder());

      expect(report.removed).toBe(0);
      expect(tables().chapters).toBe(1);
    });
  });
});

/**
 * D18 : `.cliodeck` ou `brain.db` lié hors du projet. Une sauvegarde du document relance cette
 * indexation, et elle ouvrait la base à travers le lien : les extraits du manuscrit partaient
 * dans la base d'un autre projet. Rien ne s'ouvre, le fournisseur n'est pas appelé.
 */
describe.skipIf(!sqliteAvailable || !symlinkAvailable)('manuscriptIndexService — .cliodeck lié hors du projet', () => {
  let outside = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cliodeck-mindex-ailleurs-'));
    writeProject(tmp, [{ file: '01.md', title: 'Un', body: '# Un\n\nLe port de Danzig.\n' }]);
  });

  afterEach(() => {
    manuscriptIndexService.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('.cliodeck lié dehors : ni base ouverte, ni fournisseur appelé, rien à l’autre bout', async () => {
    fs.symlinkSync(outside, path.join(tmp, '.cliodeck'));
    manuscriptIndexService.configure(tmp);
    const embedder = fakeEmbedder();

    await manuscriptIndexService.index(embedder);

    expect(manuscriptIndexService.stats()).toBeNull();
    expect(manuscriptIndexService.purgeOutside()).toBe(0);
    expect(embedder.calls).toBe(0);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('brain.db lié vers celui d’un autre projet : aucune table manuscript_* n’y arrive', async () => {
    const otherDb = path.join(outside, 'brain.db');
    const db = new Database(otherDb);
    db.exec('CREATE TABLE pdf_documents (id TEXT PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(tmp, '.cliodeck'));
    fs.symlinkSync(otherDb, path.join(tmp, '.cliodeck', 'brain.db'));
    manuscriptIndexService.configure(tmp);

    await manuscriptIndexService.index(fakeEmbedder());

    const reader = new Database(otherDb, { readonly: true });
    const names = (reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((row) => row.name);
    reader.close();
    expect(names).toEqual(['pdf_documents']);
  });
});
