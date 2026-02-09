import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { randomUUID } from 'crypto';
import type {
  PDFDocument,
  DocumentChunk,
  ChunkWithEmbedding,
  SearchResult,
  VectorStoreStatistics,
} from '../../types/pdf-document';
import type {
  Topic,
  TopicAnalysisResult,
  TopicAnalysisOptions,
} from '../analysis/TopicModelingService';

export class VectorStore {
  private db: Database.Database;
  private dbPath: string;
  public readonly projectPath: string;

  /**
   * Crée un VectorStore pour un projet spécifique
   * @param projectPath Chemin absolu vers le dossier du projet
   * @throws Error si projectPath n'est pas fourni
   */
  constructor(projectPath: string) {
    if (!projectPath) {
      throw new Error('VectorStore requires a project path. Use project-based storage only.');
    }

    this.projectPath = projectPath;
    // Base de données dans project/.cliodeck/vectors.db
    this.dbPath = path.join(projectPath, '.cliodeck', 'vectors.db');

    console.log(`📁 Base de données projet: ${this.dbPath}`);

    // Créer le dossier .cliodeck si nécessaire
    const cliodeckDir = path.join(projectPath, '.cliodeck');
    if (!existsSync(cliodeckDir)) {
      mkdirSync(cliodeckDir, { recursive: true });
      console.log(`📂 Dossier .cliodeck créé: ${cliodeckDir}`);
    }

    // S'assurer que le dossier .cliodeck a les bonnes permissions
    try {
      chmodSync(cliodeckDir, 0o755); // rwxr-xr-x
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${cliodeckDir}:`, error);
    }

    // Ouvrir la base de données
    this.db = new Database(this.dbPath);
    console.log('✅ Base de données ouverte');

    // S'assurer que le fichier de base de données a les bonnes permissions
    try {
      if (existsSync(this.dbPath)) {
        chmodSync(this.dbPath, 0o644); // rw-r--r--
      }
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${this.dbPath}:`, error);
    }

    // ✅ IMPORTANT : Activer les clés étrangères (désactivées par défaut dans SQLite)
    this.enableForeignKeys();

    // Créer les tables
    this.createTables();
  }

  private enableForeignKeys(): void {
    this.db.pragma('foreign_keys = ON');
    console.log('✅ Clés étrangères activées');
  }

  private createTables(): void {
    // Table pour les documents
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        year TEXT,
        bibtex_key TEXT,
        page_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        metadata TEXT,
        summary TEXT,
        summary_embedding BLOB,
        citations_extracted TEXT,
        language TEXT
      );
    `);

    // Table pour les chunks avec embeddings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        content TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_position INTEGER NOT NULL,
        end_position INTEGER NOT NULL,
        embedding BLOB,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
    `);

    // Table pour les citations entre documents
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_citations (
        id TEXT PRIMARY KEY,
        source_doc_id TEXT NOT NULL,
        target_citation TEXT NOT NULL,
        target_doc_id TEXT,
        context TEXT,
        page_number INTEGER,
        FOREIGN KEY (source_doc_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (target_doc_id) REFERENCES documents(id) ON DELETE SET NULL
      );
    `);

    // Table pour les similarités pré-calculées (optionnel, pour performance)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_similarities (
        doc_id_1 TEXT NOT NULL,
        doc_id_2 TEXT NOT NULL,
        similarity REAL NOT NULL,
        PRIMARY KEY (doc_id_1, doc_id_2),
        FOREIGN KEY (doc_id_1) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (doc_id_2) REFERENCES documents(id) ON DELETE CASCADE
      );
    `);

    // Tables pour la persistance des analyses de topics (BERTopic)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_analyses (
        id TEXT PRIMARY KEY,
        analysis_date TEXT NOT NULL,
        is_current INTEGER DEFAULT 1,
        options_json TEXT,
        statistics_json TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        topic_id INTEGER NOT NULL,
        label TEXT,
        keywords_json TEXT,
        size INTEGER,
        FOREIGN KEY (analysis_id) REFERENCES topic_analyses(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_assignments (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        topic_id INTEGER,
        FOREIGN KEY (analysis_id) REFERENCES topic_analyses(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_outliers (
        id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES topic_analyses(id) ON DELETE CASCADE,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
    `);

    // Table des collections Zotero
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zotero_collections (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_key TEXT,
        FOREIGN KEY (parent_key) REFERENCES zotero_collections(key) ON DELETE SET NULL
      );
    `);

    // Table de liaison documents-collections (many-to-many)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_collections (
        document_id TEXT NOT NULL,
        collection_key TEXT NOT NULL,
        PRIMARY KEY (document_id, collection_key),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (collection_key) REFERENCES zotero_collections(key) ON DELETE CASCADE
      );
    `);

    // Index pour accélérer les recherches
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_page_number ON chunks(page_number);
      CREATE INDEX IF NOT EXISTS idx_citations_source ON document_citations(source_doc_id);
      CREATE INDEX IF NOT EXISTS idx_citations_target ON document_citations(target_doc_id);
      CREATE INDEX IF NOT EXISTS idx_similarities_doc1 ON document_similarities(doc_id_1);
      CREATE INDEX IF NOT EXISTS idx_similarities_doc2 ON document_similarities(doc_id_2);
      CREATE INDEX IF NOT EXISTS idx_topics_analysis ON topics(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_topic_assignments_analysis ON topic_assignments(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_topic_assignments_document ON topic_assignments(document_id);
      CREATE INDEX IF NOT EXISTS idx_topic_outliers_analysis ON topic_outliers(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_doc_collections_coll ON document_collections(collection_key);
    `);

    console.log('✅ Tables créées');

    // Vérifier et migrer si nécessaire
    this.migrateDatabase();
  }

  private migrateDatabase(): void {
    // Vérifier si les nouvelles colonnes existent déjà dans documents
    const tableInfo = this.db.pragma('table_info(documents)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    const newColumns = [
      { name: 'summary', type: 'TEXT', default: 'NULL' },
      { name: 'summary_embedding', type: 'BLOB', default: 'NULL' },
      { name: 'citations_extracted', type: 'TEXT', default: 'NULL' },
      { name: 'language', type: 'TEXT', default: 'NULL' },
    ];

    for (const column of newColumns) {
      if (!columnNames.includes(column.name)) {
        console.log(`📝 Migration: Ajout de la colonne ${column.name} à documents`);
        this.db.exec(
          `ALTER TABLE documents ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`
        );
      }
    }

    // Migration chunks table for content_hash (Phase 2 - deduplication)
    const chunksTableInfo = this.db.pragma('table_info(chunks)') as Array<{ name: string }>;
    const chunksColumnNames = chunksTableInfo.map((col) => col.name);

    if (!chunksColumnNames.includes('content_hash')) {
      console.log('📝 Migration: Ajout de la colonne content_hash à chunks');
      this.db.exec('ALTER TABLE chunks ADD COLUMN content_hash TEXT DEFAULT NULL');
      // Create index for faster deduplication lookups
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)');
    }

    console.log('✅ Migration de la base de données terminée');
  }

  // MARK: - Document Operations

  saveDocument(document: PDFDocument): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO documents
      (id, file_path, title, author, year, bibtex_key, page_count,
       created_at, indexed_at, last_accessed_at, metadata,
       summary, summary_embedding, citations_extracted, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const metadataJSON = JSON.stringify(document.metadata);
    const citationsJSON = (document as any).citationsExtracted
      ? JSON.stringify((document as any).citationsExtracted)
      : null;

    // Convertir summary_embedding en Buffer si présent
    const summaryEmbeddingBuffer = (document as any).summaryEmbedding
      ? Buffer.from((document as any).summaryEmbedding.buffer)
      : null;

    stmt.run(
      document.id,
      document.fileURL,
      document.title,
      document.author || null,
      document.year || null,
      document.bibtexKey || null,
      document.pageCount,
      document.createdAt.toISOString(),
      document.indexedAt.toISOString(),
      document.lastAccessedAt.toISOString(),
      metadataJSON,
      (document as any).summary || null,
      summaryEmbeddingBuffer,
      citationsJSON,
      (document as any).language || null
    );

    console.log(`✅ Document sauvegardé: ${document.title}`);
  }

  getDocument(id: string): PDFDocument | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE id = ?');
    const row = stmt.get(id);

    if (!row) return null;

    return this.parseDocument(row as any);
  }

  getAllDocuments(): PDFDocument[] {
    const stmt = this.db.prepare('SELECT * FROM documents ORDER BY indexed_at DESC');
    const rows = stmt.all();

    return rows.map((row) => {
      const doc = this.parseDocument(row as any);
      // Add chunk count for this document
      const chunkCountStmt = this.db.prepare('SELECT COUNT(*) as count FROM chunks WHERE document_id = ?');
      const chunkCountRow = chunkCountStmt.get(doc.id) as { count: number };
      (doc as any).chunkCount = chunkCountRow.count;
      return doc;
    });
  }

  deleteDocument(id: string): void {
    // Les chunks seront supprimés automatiquement grâce à ON DELETE CASCADE
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(id);

    console.log(`✅ Document supprimé: ${id}`);
  }

  // MARK: - Chunk Operations

  saveChunk(chunk: DocumentChunk, embedding: Float32Array, contentHash?: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
      (id, document_id, content, page_number, chunk_index,
       start_position, end_position, embedding, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Convertir Float32Array en Buffer
    const embeddingBuffer = Buffer.from(embedding.buffer);

    stmt.run(
      chunk.id,
      chunk.documentId,
      chunk.content,
      chunk.pageNumber,
      chunk.chunkIndex,
      chunk.startPosition,
      chunk.endPosition,
      embeddingBuffer,
      contentHash || null
    );
  }

  /**
   * Find chunks with the same content hash (for deduplication)
   */
  findChunksByHash(contentHash: string, excludeDocId?: string): string[] {
    const stmt = excludeDocId
      ? this.db.prepare('SELECT id FROM chunks WHERE content_hash = ? AND document_id != ?')
      : this.db.prepare('SELECT id FROM chunks WHERE content_hash = ?');

    const rows = excludeDocId
      ? stmt.all(contentHash, excludeDocId)
      : stmt.all(contentHash);

    return (rows as any[]).map((r) => r.id);
  }

  getChunksForDocument(documentId: string): ChunkWithEmbedding[] {
    const stmt = this.db.prepare(
      'SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index'
    );
    const rows = stmt.all(documentId);

    return rows.map((row) => this.parseChunkWithEmbedding(row as any));
  }

  getAllChunksWithEmbeddings(): ChunkWithEmbedding[] {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL');
    const rows = stmt.all();

    return rows.map((row) => this.parseChunkWithEmbedding(row as any));
  }

  /**
   * Get the dimension of embeddings stored in the database
   * @returns The embedding dimension, or null if no embeddings exist
   */
  getEmbeddingDimension(): number | null {
    try {
      const stmt = this.db.prepare('SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1');
      const row = stmt.get() as { embedding: Buffer } | undefined;

      console.log('🔍 Checking embedding dimension...', {
        hasRow: !!row,
        hasEmbedding: row ? !!row.embedding : false,
        embeddingType: row ? typeof row.embedding : 'N/A',
        embeddingByteLength: row?.embedding ? row.embedding.byteLength : 0
      });

      if (!row || !row.embedding) {
        console.log('⚠️  No embeddings found in database');
        return null;
      }

      // Embedding is stored as Buffer, convert to Float32Array to get dimension
      const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const dimension = embedding.length;
      console.log(`✅ Embedding dimension detected: ${dimension}`);
      return dimension;
    } catch (error) {
      console.error('❌ Error detecting embedding dimension:', error);
      return null;
    }
  }

  // MARK: - Search Operations

  search(
    queryEmbedding: Float32Array,
    limit: number = 5,
    documentIds?: string[]
  ): SearchResult[] {
    // Récupérer tous les chunks (avec filtre optionnel par documents)
    let allChunks: ChunkWithEmbedding[];

    if (documentIds && documentIds.length > 0) {
      allChunks = [];
      for (const docId of documentIds) {
        const chunks = this.getChunksForDocument(docId);
        allChunks.push(...chunks);
      }
    } else {
      allChunks = this.getAllChunksWithEmbeddings();
    }

    // Calculer la similarité cosinus pour chaque chunk
    const scoredChunks: Array<{ chunkWithEmbedding: ChunkWithEmbedding; similarity: number }> =
      [];

    for (const chunkWithEmbedding of allChunks) {
      const similarity = this.cosineSimilarity(queryEmbedding, chunkWithEmbedding.embedding);
      scoredChunks.push({ chunkWithEmbedding, similarity });
    }

    // Trier par similarité décroissante
    scoredChunks.sort((a, b) => b.similarity - a.similarity);

    // Prendre les top-k
    const topChunks = scoredChunks.slice(0, limit);

    // Convertir en SearchResult
    const results: SearchResult[] = [];

    for (const { chunkWithEmbedding, similarity } of topChunks) {
      const document = this.getDocument(chunkWithEmbedding.chunk.documentId);
      if (document) {
        results.push({
          chunk: chunkWithEmbedding.chunk,
          document,
          similarity,
        });
      }
    }

    return results;
  }

  // MARK: - Similarity Calculation

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);

    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  // MARK: - Parsing Helpers

  private parseDocument(row: any): PDFDocument {
    const metadata = JSON.parse(row.metadata || '{}');
    const citationsExtracted = row.citations_extracted
      ? JSON.parse(row.citations_extracted)
      : undefined;

    // Extraire summary_embedding si présent
    let summaryEmbedding: Float32Array | undefined = undefined;
    if (row.summary_embedding) {
      const embeddingBuffer = row.summary_embedding as Buffer;
      summaryEmbedding = new Float32Array(
        embeddingBuffer.buffer,
        embeddingBuffer.byteOffset,
        embeddingBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT
      );
    }

    const doc: PDFDocument = {
      id: row.id,
      fileURL: row.file_path,
      title: row.title,
      author: row.author,
      year: row.year,
      bibtexKey: row.bibtex_key,
      pageCount: row.page_count,
      metadata,
      createdAt: new Date(row.created_at),
      indexedAt: new Date(row.indexed_at),
      lastAccessedAt: new Date(row.last_accessed_at),
      get displayString() {
        if (this.author && this.year) {
          return `${this.author} (${this.year})`;
        }
        return this.title;
      },
    };

    // Ajouter les nouveaux champs enrichis
    (doc as any).summary = row.summary;
    (doc as any).summaryEmbedding = summaryEmbedding;
    (doc as any).citationsExtracted = citationsExtracted;
    (doc as any).language = row.language;

    return doc;
  }

  private parseChunkWithEmbedding(row: any): ChunkWithEmbedding {
    const chunk: DocumentChunk = {
      id: row.id,
      documentId: row.document_id,
      content: row.content,
      pageNumber: row.page_number,
      chunkIndex: row.chunk_index,
      startPosition: row.start_position,
      endPosition: row.end_position,
    };

    // Extraire l'embedding du BLOB
    const embeddingBuffer = row.embedding as Buffer;
    const embedding = new Float32Array(
      embeddingBuffer.buffer,
      embeddingBuffer.byteOffset,
      embeddingBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT
    );

    return { chunk, embedding };
  }

  // MARK: - Statistics

  getStatistics(): VectorStoreStatistics {
    const documentCount = this.db.prepare('SELECT COUNT(*) as count FROM documents').get() as {
      count: number;
    };
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };
    const embeddingCount = this.db
      .prepare('SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL')
      .get() as { count: number };

    return {
      documentCount: documentCount.count,
      chunkCount: chunkCount.count,
      embeddingCount: embeddingCount.count,
      databasePath: this.dbPath,
    };
  }

  // MARK: - Purge complète

  purgeAllData(): void {
    // Supprimer tous les chunks d'abord (pour être sûr)
    this.db.exec('DELETE FROM chunks;');

    // Supprimer tous les documents
    this.db.exec('DELETE FROM documents;');

    // Vacuum pour récupérer l'espace disque
    this.db.exec('VACUUM;');

    console.log('✅ Base de données purgée complètement');
  }

  verifyIntegrity(): { orphanedChunks: number; totalChunks: number } {
    // Compter les chunks orphelins (dont le document n'existe plus)
    const orphanedCount = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM chunks
         WHERE document_id NOT IN (SELECT id FROM documents)`
      )
      .get() as { count: number };

    // Compter tous les chunks
    const totalCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
      count: number;
    };

    if (orphanedCount.count > 0) {
      console.log(
        `⚠️ ${orphanedCount.count} chunks orphelins détectés sur ${totalCount.count} total`
      );
    }

    return {
      orphanedChunks: orphanedCount.count,
      totalChunks: totalCount.count,
    };
  }

  cleanOrphanedChunks(): void {
    // Supprimer les chunks orphelins
    this.db.exec(`
      DELETE FROM chunks
      WHERE document_id NOT IN (SELECT id FROM documents)
    `);

    console.log('✅ Chunks orphelins supprimés');
  }

  // MARK: - Citation Operations

  saveCitation(citation: {
    id: string;
    sourceDocId: string;
    targetCitation: string;
    targetDocId?: string;
    context?: string;
    pageNumber?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO document_citations
      (id, source_doc_id, target_citation, target_doc_id, context, page_number)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      citation.id,
      citation.sourceDocId,
      citation.targetCitation,
      citation.targetDocId || null,
      citation.context || null,
      citation.pageNumber || null
    );
  }

  getCitationsForDocument(documentId: string): Array<{
    id: string;
    sourceDocId: string;
    targetCitation: string;
    targetDocId?: string;
    context?: string;
    pageNumber?: number;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM document_citations
      WHERE source_doc_id = ?
      ORDER BY page_number ASC
    `);

    const rows = stmt.all(documentId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sourceDocId: row.source_doc_id,
      targetCitation: row.target_citation,
      targetDocId: row.target_doc_id,
      context: row.context,
      pageNumber: row.page_number,
    }));
  }

  /**
   * Compte le nombre de citations matchées (citations internes)
   */
  getMatchedCitationsCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM document_citations
      WHERE target_doc_id IS NOT NULL
    `);

    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Compte le nombre total de citations (y compris non matchées)
   */
  getTotalCitationsCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM document_citations
    `);

    const result = stmt.get() as { count: number };
    return result.count;
  }

  getDocumentsCitedBy(documentId: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT target_doc_id FROM document_citations
      WHERE source_doc_id = ? AND target_doc_id IS NOT NULL
    `);

    const rows = stmt.all(documentId) as Array<{ target_doc_id: string }>;
    return rows.map((row) => row.target_doc_id);
  }

  getDocumentsCiting(documentId: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT source_doc_id FROM document_citations
      WHERE target_doc_id = ?
    `);

    const rows = stmt.all(documentId) as Array<{ source_doc_id: string }>;
    return rows.map((row) => row.source_doc_id);
  }

  deleteCitationsForDocument(documentId: string): void {
    const stmt = this.db.prepare('DELETE FROM document_citations WHERE source_doc_id = ?');
    stmt.run(documentId);
  }

  // MARK: - Similarity Operations

  saveSimilarity(docId1: string, docId2: string, similarity: number): void {
    // Toujours stocker avec docId1 < docId2 pour éviter les doublons
    const [id1, id2] = docId1 < docId2 ? [docId1, docId2] : [docId2, docId1];

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO document_similarities
      (doc_id_1, doc_id_2, similarity)
      VALUES (?, ?, ?)
    `);

    stmt.run(id1, id2, similarity);
  }

  getSimilarDocuments(
    documentId: string,
    threshold: number = 0.5,
    limit: number = 10
  ): Array<{ documentId: string; similarity: number }> {
    const stmt = this.db.prepare(`
      SELECT
        CASE
          WHEN doc_id_1 = ? THEN doc_id_2
          ELSE doc_id_1
        END as other_doc_id,
        similarity
      FROM document_similarities
      WHERE (doc_id_1 = ? OR doc_id_2 = ?)
        AND similarity >= ?
      ORDER BY similarity DESC
      LIMIT ?
    `);

    const rows = stmt.all(documentId, documentId, documentId, threshold, limit) as Array<{
      other_doc_id: string;
      similarity: number;
    }>;

    return rows.map((row) => ({
      documentId: row.other_doc_id,
      similarity: row.similarity,
    }));
  }

  deleteSimilaritiesForDocument(documentId: string): void {
    const stmt = this.db.prepare(
      'DELETE FROM document_similarities WHERE doc_id_1 = ? OR doc_id_2 = ?'
    );
    stmt.run(documentId, documentId);
  }

  /**
   * Calcule et sauvegarde les similarités entre un document et tous les autres documents existants
   * @param documentId ID du document pour lequel calculer les similarités
   * @param threshold Seuil minimum de similarité pour sauvegarder (par défaut 0.5)
   * @returns Nombre de similarités sauvegardées
   */
  computeAndSaveSimilarities(documentId: string, threshold: number = 0.5): number {
    console.log(`🔍 Computing similarities for document ${documentId.substring(0, 8)}... (threshold: ${threshold})`);

    // Récupérer les chunks du document donné avec leurs embeddings
    const docChunks = this.getChunksForDocument(documentId);

    if (docChunks.length === 0) {
      console.log('⚠️ No chunks found for document, skipping similarity computation');
      return 0;
    }

    // Récupérer tous les autres documents
    const allDocuments = this.getAllDocuments();
    let similaritiesCount = 0;

    for (const otherDoc of allDocuments) {
      // Ne pas se comparer avec soi-même
      if (otherDoc.id === documentId) continue;

      // Récupérer les chunks de l'autre document
      const otherChunks = this.getChunksForDocument(otherDoc.id);

      if (otherChunks.length === 0) continue;

      // Calculer la similarité moyenne entre tous les chunks
      let totalSimilarity = 0;
      let comparisons = 0;

      for (const docChunk of docChunks) {
        for (const otherChunk of otherChunks) {
          const similarity = this.cosineSimilarity(docChunk.embedding, otherChunk.embedding);
          totalSimilarity += similarity;
          comparisons++;
        }
      }

      const avgSimilarity = totalSimilarity / comparisons;

      // Sauvegarder seulement si au-dessus du seuil
      if (avgSimilarity >= threshold) {
        this.saveSimilarity(documentId, otherDoc.id, avgSimilarity);
        similaritiesCount++;
        console.log(`   ✓ Similarity with ${otherDoc.title?.substring(0, 30) || otherDoc.id.substring(0, 8)}: ${avgSimilarity.toFixed(3)}`);
      }
    }

    console.log(`✅ Computed ${similaritiesCount} similarities above threshold ${threshold}`);
    return similaritiesCount;
  }

  // MARK: - Topic Analysis Persistence

  /**
   * Sauvegarde une analyse de topics dans la base de données
   * @param result Résultat de l'analyse BERTopic
   * @param options Options utilisées pour l'analyse
   * @returns ID de l'analyse sauvegardée
   */
  saveTopicAnalysis(result: TopicAnalysisResult, options?: TopicAnalysisOptions): string {
    const analysisId = randomUUID();
    const now = new Date().toISOString();

    // Marquer toutes les analyses précédentes comme non-courantes
    this.db.prepare('UPDATE topic_analyses SET is_current = 0').run();

    // Sauvegarder l'analyse principale
    const insertAnalysis = this.db.prepare(`
      INSERT INTO topic_analyses (id, analysis_date, is_current, options_json, statistics_json)
      VALUES (?, ?, 1, ?, ?)
    `);

    insertAnalysis.run(
      analysisId,
      now,
      JSON.stringify(options || {}),
      JSON.stringify(result.statistics)
    );

    // Sauvegarder les topics
    const insertTopic = this.db.prepare(`
      INSERT INTO topics (id, analysis_id, topic_id, label, keywords_json, size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const topic of result.topics) {
      const topicDbId = randomUUID();
      insertTopic.run(
        topicDbId,
        analysisId,
        topic.id,
        topic.label,
        JSON.stringify(topic.keywords),
        topic.size
      );
    }

    // Sauvegarder les assignations
    const insertAssignment = this.db.prepare(`
      INSERT INTO topic_assignments (id, analysis_id, document_id, topic_id)
      VALUES (?, ?, ?, ?)
    `);

    for (const [docId, topicId] of Object.entries(result.topicAssignments)) {
      const assignmentId = randomUUID();
      insertAssignment.run(assignmentId, analysisId, docId, topicId);
    }

    // Sauvegarder les outliers
    const insertOutlier = this.db.prepare(`
      INSERT INTO topic_outliers (id, analysis_id, document_id)
      VALUES (?, ?, ?)
    `);

    for (const docId of result.outliers) {
      const outlierId = randomUUID();
      insertOutlier.run(outlierId, analysisId, docId);
    }

    console.log(`✅ Topic analysis saved: ${result.topics.length} topics, ${Object.keys(result.topicAssignments).length} assignments`);
    return analysisId;
  }

  /**
   * Charge la dernière analyse de topics sauvegardée
   * @returns Résultat de l'analyse ou null si aucune analyse n'existe
   */
  loadLatestTopicAnalysis(): (TopicAnalysisResult & { analysisDate: string; options: TopicAnalysisOptions }) | null {
    // Récupérer l'analyse la plus récente
    const analysis = this.db.prepare(`
      SELECT * FROM topic_analyses
      WHERE is_current = 1
      ORDER BY analysis_date DESC
      LIMIT 1
    `).get() as { id: string; analysis_date: string; options_json: string; statistics_json: string } | undefined;

    if (!analysis) {
      console.log('ℹ️ No saved topic analysis found');
      return null;
    }

    const analysisId = analysis.id;

    // Récupérer les topics
    const topicsRows = this.db.prepare(`
      SELECT topic_id, label, keywords_json, size
      FROM topics
      WHERE analysis_id = ?
      ORDER BY topic_id
    `).all(analysisId) as Array<{
      topic_id: number;
      label: string;
      keywords_json: string;
      size: number;
    }>;

    const topics: Topic[] = topicsRows.map((row) => ({
      id: row.topic_id,
      label: row.label,
      keywords: JSON.parse(row.keywords_json),
      documents: [], // Sera rempli ci-dessous
      size: row.size,
    }));

    // Récupérer les assignations
    const assignmentsRows = this.db.prepare(`
      SELECT document_id, topic_id
      FROM topic_assignments
      WHERE analysis_id = ?
    `).all(analysisId) as Array<{ document_id: string; topic_id: number }>;

    const topicAssignments: Record<string, number> = {};
    for (const row of assignmentsRows) {
      topicAssignments[row.document_id] = row.topic_id;

      // Ajouter le document_id à la liste des documents du topic
      const topic = topics.find((t) => t.id === row.topic_id);
      if (topic) {
        topic.documents.push(row.document_id);
      }
    }

    // Récupérer les outliers
    const outliersRows = this.db.prepare(`
      SELECT document_id
      FROM topic_outliers
      WHERE analysis_id = ?
    `).all(analysisId) as Array<{ document_id: string }>;

    const outliers = outliersRows.map((row) => row.document_id);

    const result: TopicAnalysisResult & { analysisDate: string; options: TopicAnalysisOptions } = {
      topics,
      topicAssignments,
      outliers,
      statistics: JSON.parse(analysis.statistics_json),
      analysisDate: analysis.analysis_date,
      options: JSON.parse(analysis.options_json),
    };

    console.log(`✅ Loaded topic analysis: ${topics.length} topics, ${Object.keys(topicAssignments).length} assignments`);
    return result;
  }

  /**
   * Récupère les données temporelles des topics (pour stream graph)
   * Retourne le nombre de documents par topic par année
   */
  getTopicTimeline(): Array<{ year: number; [topicId: string]: number }> | null {
    // Récupérer l'analyse actuelle
    const analysis = this.db.prepare(`
      SELECT id FROM topic_analyses
      WHERE is_current = 1
      ORDER BY analysis_date DESC
      LIMIT 1
    `).get() as { id: string } | undefined;

    if (!analysis) {
      console.log('ℹ️ No topic analysis found for timeline');
      return null;
    }

    // Récupérer les assignments avec les années des documents
    const timelineData = this.db.prepare(`
      SELECT
        d.year,
        ta.topic_id
      FROM topic_assignments ta
      JOIN documents d ON ta.document_id = d.id
      WHERE ta.analysis_id = ? AND d.year IS NOT NULL
      ORDER BY d.year
    `).all(analysis.id) as Array<{ year: number; topic_id: number }>;

    if (timelineData.length === 0) {
      console.log('ℹ️ No timeline data found (documents may not have year metadata)');
      return null;
    }

    // Grouper par année
    const yearMap = new Map<number, Map<number, number>>();

    for (const row of timelineData) {
      if (!yearMap.has(row.year)) {
        yearMap.set(row.year, new Map());
      }
      const topicMap = yearMap.get(row.year)!;
      topicMap.set(row.topic_id, (topicMap.get(row.topic_id) || 0) + 1);
    }

    // Convertir en format pour stream graph
    const result: Array<{ year: number; [topicId: string]: number }> = [];

    // Trier les années
    const sortedYears = Array.from(yearMap.keys()).sort((a, b) => a - b);

    for (const year of sortedYears) {
      const topicCounts = yearMap.get(year)!;
      const yearData: any = { year };

      // Ajouter les counts pour chaque topic
      for (const [topicId, count] of topicCounts.entries()) {
        yearData[`topic_${topicId}`] = count;
      }

      result.push(yearData);
    }

    console.log(`✅ Topic timeline computed: ${result.length} years, ${timelineData.length} documents`);
    return result;
  }

  /**
   * Supprime toutes les analyses de topics
   */
  deleteAllTopicAnalyses(): void {
    this.db.prepare('DELETE FROM topic_analyses').run();
    console.log('✅ All topic analyses deleted');
  }

  // MARK: - Zotero Collection Operations

  /**
   * Sauvegarde plusieurs collections Zotero en batch
   */
  saveCollections(collections: Array<{ key: string; name: string; parentKey?: string }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO zotero_collections (key, name, parent_key)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const coll of collections) {
        stmt.run(coll.key, coll.name, coll.parentKey || null);
      }
    });
    transaction();

    console.log(`✅ ${collections.length} collections sauvegardées`);
  }

  /**
   * Récupère toutes les collections Zotero
   */
  getAllCollections(): Array<{ key: string; name: string; parentKey?: string }> {
    const stmt = this.db.prepare('SELECT key, name, parent_key FROM zotero_collections ORDER BY name');
    const rows = stmt.all() as Array<{ key: string; name: string; parent_key: string | null }>;
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      parentKey: row.parent_key || undefined,
    }));
  }

  /**
   * Lie un document à ses collections Zotero
   */
  setDocumentCollections(documentId: string, collectionKeys: string[]): void {
    // D'abord supprimer les liens existants
    this.db.prepare('DELETE FROM document_collections WHERE document_id = ?').run(documentId);

    // Puis ajouter les nouveaux liens
    if (collectionKeys.length > 0) {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO document_collections (document_id, collection_key)
        VALUES (?, ?)
      `);

      const transaction = this.db.transaction(() => {
        for (const collKey of collectionKeys) {
          stmt.run(documentId, collKey);
        }
      });
      transaction();
    }

    console.log(`✅ Document ${documentId.substring(0, 8)} lié à ${collectionKeys.length} collection(s)`);
  }

  /**
   * Récupère les clés de collections pour un document
   */
  getDocumentCollections(documentId: string): string[] {
    const stmt = this.db.prepare('SELECT collection_key FROM document_collections WHERE document_id = ?');
    const rows = stmt.all(documentId) as Array<{ collection_key: string }>;
    return rows.map((row) => row.collection_key);
  }

  /**
   * Récupère tous les IDs de documents appartenant aux collections spécifiées
   * @param collectionKeys Clés des collections à filtrer
   * @param recursive Si true, inclut aussi les sous-collections
   */
  getDocumentIdsInCollections(collectionKeys: string[], recursive: boolean = true): string[] {
    if (collectionKeys.length === 0) {
      return [];
    }

    let allCollectionKeys = [...collectionKeys];

    // Si récursif, inclure aussi toutes les sous-collections
    if (recursive) {
      const allCollections = this.getAllCollections();
      const collectSubcollections = (parentKeys: string[]): string[] => {
        const children = allCollections
          .filter((c) => c.parentKey && parentKeys.includes(c.parentKey))
          .map((c) => c.key);
        if (children.length > 0) {
          return [...children, ...collectSubcollections(children)];
        }
        return [];
      };
      allCollectionKeys = [...allCollectionKeys, ...collectSubcollections(collectionKeys)];
    }

    // Construire la requête paramétrée
    const placeholders = allCollectionKeys.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT DISTINCT document_id
      FROM document_collections
      WHERE collection_key IN (${placeholders})
    `);

    const rows = stmt.all(...allCollectionKeys) as Array<{ document_id: string }>;
    return rows.map((row) => row.document_id);
  }

  /**
   * Supprime toutes les collections (utile lors d'une re-synchronisation)
   */
  deleteAllCollections(): void {
    this.db.prepare('DELETE FROM zotero_collections').run();
    console.log('✅ Toutes les collections supprimées');
  }

  /**
   * Lie des documents à leurs collections Zotero en utilisant le bibtexKey
   * @param bibtexKeyToCollections Map de bibtexKey -> array de collection keys
   * @returns Nombre de documents liés avec succès
   */
  linkDocumentsToCollectionsByBibtexKey(bibtexKeyToCollections: Record<string, string[]>): number {
    let linkedCount = 0;

    // Get all documents with their bibtex_key
    const documents = this.db
      .prepare('SELECT id, bibtex_key FROM documents WHERE bibtex_key IS NOT NULL')
      .all() as Array<{ id: string; bibtex_key: string }>;

    console.log(`🔗 Attempting to link ${documents.length} documents to collections...`);
    console.log(`📋 Collection mapping has ${Object.keys(bibtexKeyToCollections).length} entries`);

    // Debug: show sample keys from both sides to help diagnose mismatches
    if (documents.length > 0) {
      const sampleDocKeys = documents.slice(0, 5).map(d => d.bibtex_key);
      console.log(`📄 Sample document bibtexKeys: ${sampleDocKeys.join(', ')}`);
    }
    const mappingKeys = Object.keys(bibtexKeyToCollections);
    if (mappingKeys.length > 0) {
      const sampleMappingKeys = mappingKeys.slice(0, 5);
      console.log(`📎 Sample Zotero bibtexKeys: ${sampleMappingKeys.join(', ')}`);
    }

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO document_collections (document_id, collection_key)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const doc of documents) {
        const collectionKeys = bibtexKeyToCollections[doc.bibtex_key];
        if (collectionKeys && collectionKeys.length > 0) {
          // First, remove existing links for this document
          this.db.prepare('DELETE FROM document_collections WHERE document_id = ?').run(doc.id);

          // Then add new links
          for (const collKey of collectionKeys) {
            insertStmt.run(doc.id, collKey);
          }
          linkedCount++;
          console.log(`  ✅ Linked document "${doc.bibtex_key}" to ${collectionKeys.length} collection(s)`);
        }
      }
    });

    transaction();
    console.log(`✅ Successfully linked ${linkedCount} documents to their Zotero collections`);
    return linkedCount;
  }

  // Fermer la base de données
  close(): void {
    this.db.close();
    console.log('✅ Base de données fermée');
  }
}
