/**
 * Indexation du manuscrit : intégration bout en bout (item 25 des audits).
 *
 * On exerce le vrai service contre un vrai projet sur disque et un vrai
 * store SQLite ; seul le fournisseur d'embeddings est simulé — appeler
 * Ollama depuis une suite de tests la rendrait lente et dépendante d'un
 * démon. Le simulacre compte ses appels : c'est ce compteur qui prouve
 * l'incrémental, pas une assertion sur un log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sqliteAvailable } from '../../../../backend/__tests__/helpers/native-guards.js';
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
});
