/**
 * Un extrait dans chaque corpus d'un projet de test, écrit par les vrais magasins sur le vrai
 * `brain.db`. Depuis H6, un corpus sans extrait n'embarque plus la question : un test qui veut voir
 * la recherche embarquer (cache, journal d'usage, panne du fournisseur) doit d'abord lui donner de
 * quoi chercher.
 */
import path from 'path';
import type { EnhancedVectorStore } from '../../../../../backend/core/vector-store/EnhancedVectorStore.js';
import type { PDFDocument } from '../../../../../backend/types/pdf-document.js';
import { ObsidianVaultStore } from '../../../../../backend/integrations/obsidian/ObsidianVaultStore.js';
import { obsidianStorePath } from '../../../../../backend/integrations/obsidian/ObsidianVaultIndexer.js';
import { ManuscriptStore, manuscriptStorePath } from '../../../../../backend/core/vector-store/ManuscriptStore.js';
import { ReadingNotesStore, readingNotesStorePath } from '../../../../../backend/core/vector-store/ReadingNotesStore.js';

const vector = (dimension: number): Float32Array => new Float32Array(dimension).fill(0.1);

/**
 * Un PDF indexé comme le fait `PDFIndexer` : la dimension adoptée, SQLite d'un bloc, puis HNSW et
 * BM25.
 */
export async function seedPdf(store: EnhancedVectorStore, project: string, dimension = 768): Promise<void> {
  await store.adoptEmbeddingDimension(dimension);
  const now = new Date();
  const chunk = {
    id: 'doc1-c0',
    documentId: 'doc1',
    content: 'Rapport sur la grève des dockers de 1907.',
    pageNumber: 1,
    chunkIndex: 0,
    startPosition: 0,
    endPosition: 40,
  };
  store.transaction(() => {
    store.saveDocument({
      id: 'doc1',
      fileURL: path.join(project, 'doc1.pdf'),
      title: 'Rapport',
      pageCount: 1,
      metadata: {},
      createdAt: now,
      indexedAt: now,
      lastAccessedAt: now,
      displayString: 'Rapport',
    } as PDFDocument);
    store.saveChunk(chunk, vector(dimension));
  });
  await store.addToSearchIndexes([{ chunk, embedding: vector(dimension) }]);
}

/** Une note de coffre, rangée sous un coffre `coffre/` du projet. */
export function seedVault(project: string, dimension = 768): void {
  const vault = new ObsidianVaultStore({ dbPath: obsidianStorePath(project), dimension });
  try {
    vault.upsertNote({
      id: 'n1', relativePath: 'greve.md', vaultPath: path.join(project, 'coffre'), title: 'Grève',
      tags: [], frontmatter: {}, wikilinks: [], fileHash: 'h1', fileMtime: 0, indexedAt: new Date().toISOString(),
    });
    vault.addChunk({ id: 'n1-c0', noteId: 'n1', chunkIndex: 0, content: 'Le comité de grève.', startPosition: 0, endPosition: 19 }, vector(dimension));
  } finally {
    vault.close();
  }
}

export function seedManuscript(project: string, dimension = 768): void {
  const manuscript = new ManuscriptStore({ dbPath: manuscriptStorePath(project) });
  try {
    manuscript.upsertChapter({ id: 'document.md', relativePath: 'document.md', title: 'Article', order: 0, contentHash: 'h', indexedAt: new Date().toISOString() });
    manuscript.addChunk({ id: 'm-c0', chapterId: 'document.md', chunkIndex: 0, content: 'Mon chapitre sur la grève.', line: 1 }, vector(dimension));
  } finally {
    manuscript.close();
  }
}

export function seedReadingNotes(project: string, dimension = 768): void {
  const notes = new ReadingNotesStore({ dbPath: readingNotesStorePath(project) });
  try {
    notes.upsertNote({
      id: 'citekey:Perrot_1974', relativePath: 'reading-notes/Perrot_1974.md', citekey: 'Perrot_1974',
      tags: [], contentHash: 'h', indexedAt: new Date().toISOString(),
    });
    notes.addChunk({ id: 'r-c0', noteId: 'citekey:Perrot_1974', chunkIndex: 0, content: 'Les ouvriers en grève.', line: 1 }, vector(dimension));
  } finally {
    notes.close();
  }
}
