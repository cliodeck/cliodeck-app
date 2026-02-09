import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync, chmodSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import hnswlib from 'hnswlib-node';
import natural from 'natural';
import type { PrimarySourceItem, PrimarySourcePhoto } from '../../integrations/tropy/TropyReader';
import type {
  Entity,
  EntityType,
  EntityMention,
  ExtractedEntity,
  EntityStatistics,
  ENTITY_TYPE_WEIGHTS,
} from '../../types/entity';
import { entityNormalizer } from '../ner/EntityNormalizer';

const { HierarchicalNSW } = hnswlib;
type HierarchicalNSW = InstanceType<typeof HierarchicalNSW>;
const { TfIdf } = natural;

// MARK: - Types

export interface PrimarySourceDocument {
  id: string;
  tropyId: number;
  title: string;
  date?: string;
  creator?: string;
  archive?: string;
  collection?: string;
  type?: string;
  transcription?: string;
  transcriptionSource?: 'tesseract' | 'transkribus' | 'manual' | 'tropy-notes';
  language?: string;
  lastModified: string;
  indexedAt: string;
  metadata?: Record<string, string>;
}

export interface PrimarySourceChunk {
  id: string;
  sourceId: string;
  content: string;
  chunkIndex: number;
  startPosition: number;
  endPosition: number;
}

export interface PrimarySourceSearchResult {
  chunk: PrimarySourceChunk;
  source: PrimarySourceDocument;
  similarity: number;
  sourceType: 'primary';
}

export interface PrimarySourcesStatistics {
  sourceCount: number;
  chunkCount: number;
  photoCount: number;
  withTranscription: number;
  withoutTranscription: number;
  byArchive: Record<string, number>;
  byCollection: Record<string, number>;
  tags: string[];
}

// MARK: - PrimarySourcesVectorStore

/**
 * VectorStore dédié aux sources primaires (Tropy)
 * Base de données séparée de celle des PDFs (sources secondaires)
 */
export class PrimarySourcesVectorStore {
  private db: Database.Database;
  private dbPath: string;
  public readonly projectPath: string;

  // HNSW Index for fast approximate nearest neighbor search
  private hnswIndex: HierarchicalNSW | null = null;
  private hnswIndexPath: string;
  private hnswDimension: number = 768;
  private hnswMaxElements: number = 100000;
  private hnswLabelMap: Map<number, string> = new Map(); // HNSW label -> chunk ID
  private hnswCurrentSize: number = 0;
  private hnswInitialized: boolean = false;

  // BM25 Index for keyword-based search
  private bm25Index: any;
  private bm25ChunkMap: Map<number, PrimarySourceChunk> = new Map();
  private bm25IdfCache: Map<string, number> = new Map();
  private bm25AvgDocLength: number = 0;
  private bm25IsDirty: boolean = true;

  // BM25 parameters
  private readonly bm25K1 = 1.5;
  private readonly bm25B = 0.75;

  // HNSW parameters
  private readonly hnswM = 16;
  private readonly hnswEfConstruction = 100;
  private hnswEfSearch = 50;

  // Hybrid search parameters
  private readonly rrfK = 60;
  private denseWeight = 0.6;
  private sparseWeight = 0.4;

  constructor(projectPath: string) {
    if (!projectPath) {
      throw new Error('PrimarySourcesVectorStore requires a project path.');
    }

    this.projectPath = projectPath;
    // Base de données séparée: project/.cliodeck/primary-sources.db
    this.dbPath = path.join(projectPath, '.cliodeck', 'primary-sources.db');
    this.hnswIndexPath = path.join(projectPath, '.cliodeck', 'primary-hnsw.index');

    console.log(`📁 Primary sources database: ${this.dbPath}`);

    // Créer le dossier .cliodeck si nécessaire
    const cliodeckDir = path.join(projectPath, '.cliodeck');
    if (!existsSync(cliodeckDir)) {
      mkdirSync(cliodeckDir, { recursive: true });
    }

    try {
      chmodSync(cliodeckDir, 0o755);
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${cliodeckDir}:`, error);
    }

    // Ouvrir la base de données
    this.db = new Database(this.dbPath);
    console.log('✅ Primary sources database opened');

    try {
      if (existsSync(this.dbPath)) {
        chmodSync(this.dbPath, 0o644);
      }
    } catch (error) {
      console.warn(`⚠️  Could not set permissions on ${this.dbPath}:`, error);
    }

    this.enableForeignKeys();
    this.createTables();

    // Initialize BM25 index
    this.bm25Index = new TfIdf();

    // Initialize HNSW and BM25 from existing data
    this.initializeIndexes();
  }

  /**
   * Initialize HNSW and BM25 indexes from existing data
   */
  private initializeIndexes(): void {
    try {
      // Detect embedding dimension from existing data
      const detectedDim = this.getEmbeddingDimension();
      if (detectedDim) {
        this.hnswDimension = detectedDim;
        console.log(`📏 Primary sources: detected embedding dimension ${this.hnswDimension}`);
      }

      // Try to load existing HNSW index
      if (existsSync(this.hnswIndexPath)) {
        this.loadHNSWIndex();
      } else {
        this.initNewHNSWIndex();
      }

      // Rebuild BM25 from database
      this.rebuildBM25Index();

    } catch (error) {
      console.warn('⚠️ Primary sources: Failed to initialize indexes, will rebuild on first search:', error);
      this.initNewHNSWIndex();
    }
  }

  /**
   * Initialize a new empty HNSW index
   */
  private initNewHNSWIndex(): void {
    this.hnswIndex = new HierarchicalNSW('cosine', this.hnswDimension);
    this.hnswIndex.initIndex(this.hnswMaxElements, this.hnswM, this.hnswEfConstruction);
    this.hnswLabelMap.clear();
    this.hnswCurrentSize = 0;
    this.hnswInitialized = true;
    console.log('🆕 Primary sources: Created new HNSW index');
  }

  /**
   * Load HNSW index from disk
   */
  private loadHNSWIndex(): void {
    try {
      this.hnswIndex = new HierarchicalNSW('cosine', this.hnswDimension);
      this.hnswIndex.readIndexSync(this.hnswIndexPath);
      this.hnswCurrentSize = this.hnswIndex.getCurrentCount();

      // Load metadata
      const metadataPath = this.hnswIndexPath + '.meta.json';
      if (existsSync(metadataPath)) {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        this.hnswLabelMap = new Map(metadata.labelMap || []);
        this.hnswDimension = metadata.dimension || this.hnswDimension;
      }

      this.hnswInitialized = true;
      console.log(`✅ Primary sources: Loaded HNSW index with ${this.hnswCurrentSize} vectors`);
    } catch (error) {
      console.warn('⚠️ Primary sources: Failed to load HNSW index, creating new:', error);
      this.initNewHNSWIndex();
    }
  }

  /**
   * Save HNSW index to disk
   */
  saveHNSWIndex(): void {
    if (!this.hnswInitialized || !this.hnswIndex) return;

    try {
      this.hnswIndex.writeIndexSync(this.hnswIndexPath);

      // Save metadata
      const metadataPath = this.hnswIndexPath + '.meta.json';
      const metadata = {
        dimension: this.hnswDimension,
        currentSize: this.hnswCurrentSize,
        labelMap: Array.from(this.hnswLabelMap.entries()),
      };
      writeFileSync(metadataPath, JSON.stringify(metadata));

      console.log(`💾 Primary sources: Saved HNSW index (${this.hnswCurrentSize} vectors)`);
    } catch (error) {
      console.error('❌ Primary sources: Failed to save HNSW index:', error);
    }
  }

  /**
   * Rebuild BM25 index from database
   */
  private rebuildBM25Index(): void {
    const startTime = Date.now();
    this.bm25Index = new TfIdf();
    this.bm25ChunkMap.clear();

    const rows = this.db.prepare('SELECT * FROM source_chunks').all() as any[];
    let docIndex = 0;

    for (const row of rows) {
      const chunk: PrimarySourceChunk = {
        id: row.id,
        sourceId: row.source_id,
        content: row.content,
        chunkIndex: row.chunk_index,
        startPosition: row.start_position,
        endPosition: row.end_position,
      };

      this.bm25Index.addDocument(this.preprocessTextForBM25(chunk.content));
      this.bm25ChunkMap.set(docIndex, chunk);
      docIndex++;
    }

    this.bm25IsDirty = true;

    const duration = Date.now() - startTime;
    console.log(`✅ Primary sources: BM25 index rebuilt with ${this.bm25ChunkMap.size} chunks in ${duration}ms`);
  }

  /**
   * Preprocess text for BM25 indexing
   */
  private preprocessTextForBM25(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Update BM25 IDF cache
   */
  private updateBM25Cache(): void {
    this.bm25IdfCache.clear();

    const N = this.bm25Index.documents.length;
    if (N === 0) {
      this.bm25AvgDocLength = 0;
      this.bm25IsDirty = false;
      return;
    }

    const termDocFreq = new Map<string, number>();
    let totalLength = 0;

    for (const doc of this.bm25Index.documents) {
      const docLength = Object.keys(doc).length;
      totalLength += docLength;

      for (const term in doc) {
        const termLower = term.toLowerCase();
        termDocFreq.set(termLower, (termDocFreq.get(termLower) || 0) + 1);
      }
    }

    this.bm25AvgDocLength = totalLength / N;

    for (const [term, df] of termDocFreq.entries()) {
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      this.bm25IdfCache.set(term, idf);
    }

    this.bm25IsDirty = false;
  }

  private enableForeignKeys(): void {
    this.db.pragma('foreign_keys = ON');
  }

  private createTables(): void {
    // Table principale des sources primaires
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS primary_sources (
        id TEXT PRIMARY KEY,
        tropy_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        date TEXT,
        creator TEXT,
        archive TEXT,
        collection TEXT,
        type TEXT,
        transcription TEXT,
        transcription_source TEXT,
        language TEXT,
        last_modified TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        metadata TEXT
      );
    `);

    // Table des photos associées aux sources
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_photos (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        mimetype TEXT,
        has_transcription INTEGER DEFAULT 0,
        transcription TEXT,
        FOREIGN KEY (source_id) REFERENCES primary_sources(id) ON DELETE CASCADE
      );
    `);

    // Table des chunks avec embeddings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_position INTEGER NOT NULL,
        end_position INTEGER NOT NULL,
        embedding BLOB,
        FOREIGN KEY (source_id) REFERENCES primary_sources(id) ON DELETE CASCADE
      );
    `);

    // Table des tags (many-to-many)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_tags (
        source_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (source_id, tag),
        FOREIGN KEY (source_id) REFERENCES primary_sources(id) ON DELETE CASCADE
      );
    `);

    // Table pour stocker les infos du projet Tropy lié
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_projects (
        id TEXT PRIMARY KEY,
        tpy_path TEXT NOT NULL,
        name TEXT NOT NULL,
        last_sync TEXT NOT NULL,
        auto_sync INTEGER DEFAULT 0
      );
    `);

    // Indexes pour performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_source_chunks_source ON source_chunks(source_id);
      CREATE INDEX IF NOT EXISTS idx_source_tags_tag ON source_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_source_photos_source ON source_photos(source_id);
      CREATE INDEX IF NOT EXISTS idx_primary_sources_tropy_id ON primary_sources(tropy_id);
      CREATE INDEX IF NOT EXISTS idx_primary_sources_archive ON primary_sources(archive);
      CREATE INDEX IF NOT EXISTS idx_primary_sources_collection ON primary_sources(collection);
    `);

    // Entity tables for Graph RAG
    this.createEntityTables();

    console.log('✅ Primary sources tables created');
  }

  /**
   * Creates entity tables for Graph RAG (NER)
   */
  private createEntityTables(): void {
    // Table des entités uniques
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        aliases TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Index pour recherche rapide
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    `);

    // Mentions d'entités dans les chunks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_mentions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        chunk_id TEXT,
        source_id TEXT NOT NULL,
        start_position INTEGER,
        end_position INTEGER,
        context TEXT,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (source_id) REFERENCES primary_sources(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk ON entity_mentions(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_entity_mentions_source ON entity_mentions(source_id);
    `);

    // Relations entre entités (co-occurrences)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_relations (
        entity1_id TEXT NOT NULL,
        entity2_id TEXT NOT NULL,
        relation_type TEXT DEFAULT 'co-occurrence',
        weight INTEGER DEFAULT 1,
        source_ids TEXT,
        PRIMARY KEY (entity1_id, entity2_id),
        FOREIGN KEY (entity1_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (entity2_id) REFERENCES entities(id) ON DELETE CASCADE
      );
    `);

    console.log('✅ Entity tables created for Graph RAG');
  }

  // MARK: - Source CRUD

  /**
   * Sauvegarde une source primaire
   */
  saveSource(source: PrimarySourceItem): string {
    const id = source.id || randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO primary_sources
      (id, tropy_id, title, date, creator, archive, collection, type,
       transcription, transcription_source, language, last_modified, indexed_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      source.tropyId,
      source.title,
      source.date || null,
      source.creator || null,
      source.archive || null,
      source.collection || null,
      source.type || null,
      source.transcription || null,
      source.transcriptionSource || null,
      null, // language - à détecter plus tard
      source.lastModified.toISOString(),
      now,
      source.metadata ? JSON.stringify(source.metadata) : null
    );

    // Sauvegarder les photos
    this.saveSourcePhotos(id, source.photos);

    // Sauvegarder les tags
    this.saveSourceTags(id, source.tags);

    return id;
  }

  /**
   * Met à jour une source existante
   */
  updateSource(id: string, updates: Partial<PrimarySourceItem>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.date !== undefined) {
      fields.push('date = ?');
      values.push(updates.date);
    }
    if (updates.creator !== undefined) {
      fields.push('creator = ?');
      values.push(updates.creator);
    }
    if (updates.archive !== undefined) {
      fields.push('archive = ?');
      values.push(updates.archive);
    }
    if (updates.collection !== undefined) {
      fields.push('collection = ?');
      values.push(updates.collection);
    }
    if (updates.transcription !== undefined) {
      fields.push('transcription = ?');
      values.push(updates.transcription);
    }
    if (updates.transcriptionSource !== undefined) {
      fields.push('transcription_source = ?');
      values.push(updates.transcriptionSource);
    }
    if (updates.lastModified !== undefined) {
      fields.push('last_modified = ?');
      values.push(updates.lastModified.toISOString());
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE primary_sources SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);

    // Mettre à jour les tags si fournis
    if (updates.tags) {
      this.saveSourceTags(id, updates.tags);
    }
  }

  /**
   * Récupère une source par son ID
   */
  getSource(id: string): PrimarySourceDocument | null {
    const row = this.db.prepare('SELECT * FROM primary_sources WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToDocument(row);
  }

  /**
   * Récupère une source par son ID Tropy
   */
  getSourceByTropyId(tropyId: number): PrimarySourceDocument | null {
    const row = this.db
      .prepare('SELECT * FROM primary_sources WHERE tropy_id = ?')
      .get(tropyId) as any;
    if (!row) return null;
    return this.rowToDocument(row);
  }

  /**
   * Liste toutes les sources
   */
  getAllSources(): PrimarySourceDocument[] {
    const rows = this.db.prepare('SELECT * FROM primary_sources ORDER BY title').all() as any[];
    return rows.map((row) => this.rowToDocument(row));
  }

  /**
   * Supprime une source
   */
  deleteSource(id: string): void {
    this.db.prepare('DELETE FROM primary_sources WHERE id = ?').run(id);
  }

  /**
   * Vérifie si une source existe par son ID Tropy
   */
  sourceExistsByTropyId(tropyId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM primary_sources WHERE tropy_id = ?')
      .get(tropyId);
    return row !== undefined;
  }

  // MARK: - Photos

  private saveSourcePhotos(sourceId: string, photos: PrimarySourcePhoto[]): void {
    // Supprimer les photos existantes
    this.db.prepare('DELETE FROM source_photos WHERE source_id = ?').run(sourceId);

    const stmt = this.db.prepare(`
      INSERT INTO source_photos
      (id, source_id, path, filename, width, height, mimetype, has_transcription, transcription)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const photo of photos) {
      stmt.run(
        photo.id,
        sourceId,
        photo.path,
        photo.filename,
        photo.width || null,
        photo.height || null,
        photo.mimetype || null,
        photo.hasTranscription ? 1 : 0,
        photo.transcription || null
      );
    }
  }

  /**
   * Récupère les photos d'une source
   */
  getSourcePhotos(sourceId: string): PrimarySourcePhoto[] {
    const rows = this.db
      .prepare('SELECT * FROM source_photos WHERE source_id = ?')
      .all(sourceId) as any[];

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      filename: row.filename,
      width: row.width,
      height: row.height,
      mimetype: row.mimetype,
      hasTranscription: row.has_transcription === 1,
      transcription: row.transcription,
      notes: [],
    }));
  }

  /**
   * Met à jour la transcription d'une photo
   */
  updatePhotoTranscription(photoId: number, transcription: string): void {
    this.db
      .prepare('UPDATE source_photos SET transcription = ?, has_transcription = 1 WHERE id = ?')
      .run(transcription, photoId);
  }

  // MARK: - Tags

  private saveSourceTags(sourceId: string, tags: string[]): void {
    // Supprimer les tags existants
    this.db.prepare('DELETE FROM source_tags WHERE source_id = ?').run(sourceId);

    const stmt = this.db.prepare('INSERT INTO source_tags (source_id, tag) VALUES (?, ?)');
    for (const tag of tags) {
      stmt.run(sourceId, tag);
    }
  }

  /**
   * Récupère les tags d'une source
   */
  getSourceTags(sourceId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM source_tags WHERE source_id = ?')
      .all(sourceId) as any[];
    return rows.map((row) => row.tag);
  }

  /**
   * Liste tous les tags uniques
   */
  getAllTags(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT tag FROM source_tags ORDER BY tag').all() as any[];
    return rows.map((row) => row.tag);
  }

  // MARK: - Chunks & Embeddings

  /**
   * Sauvegarde un chunk avec son embedding
   */
  saveChunk(chunk: PrimarySourceChunk, embedding: Float32Array): void {
    const embeddingBuffer = Buffer.from(embedding.buffer);

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO source_chunks
      (id, source_id, content, chunk_index, start_position, end_position, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        chunk.id,
        chunk.sourceId,
        chunk.content,
        chunk.chunkIndex,
        chunk.startPosition,
        chunk.endPosition,
        embeddingBuffer
      );

    // Add to HNSW index
    this.addToHNSWIndex(chunk.id, embedding);

    // Add to BM25 index
    this.addToBM25Index(chunk);
  }

  /**
   * Add a chunk to HNSW index
   */
  private addToHNSWIndex(chunkId: string, embedding: Float32Array): void {
    if (!this.hnswInitialized || !this.hnswIndex) {
      this.initNewHNSWIndex();
    }

    if (this.hnswCurrentSize >= this.hnswMaxElements) {
      console.warn('⚠️ Primary sources: HNSW index full');
      return;
    }

    // Check embedding dimension - reinitialize index if dimension changed
    if (embedding.length !== this.hnswDimension) {
      console.log(`📏 Primary sources: Embedding dimension changed (${this.hnswDimension} -> ${embedding.length}), reinitializing HNSW index`);
      this.hnswDimension = embedding.length;
      this.initNewHNSWIndex();
    }

    const label = this.hnswCurrentSize;
    const embeddingArray = Array.from(embedding);
    this.hnswIndex!.addPoint(embeddingArray, label);
    this.hnswLabelMap.set(label, chunkId);
    this.hnswCurrentSize++;
  }

  /**
   * Add a chunk to BM25 index
   */
  private addToBM25Index(chunk: PrimarySourceChunk): void {
    const docIndex = this.bm25Index.documents.length;
    this.bm25Index.addDocument(this.preprocessTextForBM25(chunk.content));
    this.bm25ChunkMap.set(docIndex, chunk);
    this.bm25IsDirty = true;
  }

  /**
   * Sauvegarde plusieurs chunks
   */
  saveChunks(chunks: Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO source_chunks
      (id, source_id, content, chunk_index, start_position, end_position, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const { chunk, embedding } of chunks) {
        const embeddingBuffer = Buffer.from(embedding.buffer);
        stmt.run(
          chunk.id,
          chunk.sourceId,
          chunk.content,
          chunk.chunkIndex,
          chunk.startPosition,
          chunk.endPosition,
          embeddingBuffer
        );
      }
    });

    transaction();
  }

  /**
   * Récupère tous les chunks d'une source
   */
  getChunks(sourceId: string): PrimarySourceChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM source_chunks WHERE source_id = ? ORDER BY chunk_index')
      .all(sourceId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      content: row.content,
      chunkIndex: row.chunk_index,
      startPosition: row.start_position,
      endPosition: row.end_position,
    }));
  }

  /**
   * Récupère tous les chunks avec leurs embeddings
   */
  getAllChunksWithEmbeddings(): Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }> {
    const rows = this.db.prepare('SELECT * FROM source_chunks').all() as any[];

    return rows.map((row) => {
      let embedding: Float32Array;

      if (row.embedding && row.embedding instanceof Buffer) {
        // Convert Buffer to Float32Array properly
        const buffer = row.embedding;
        const floatCount = buffer.byteLength / 4;
        embedding = new Float32Array(floatCount);
        for (let i = 0; i < floatCount; i++) {
          embedding[i] = buffer.readFloatLE(i * 4);
        }
      } else if (row.embedding) {
        // Fallback for other buffer types
        embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      } else {
        embedding = new Float32Array(0);
      }

      return {
        chunk: {
          id: row.id,
          sourceId: row.source_id,
          content: row.content,
          chunkIndex: row.chunk_index,
          startPosition: row.start_position,
          endPosition: row.end_position,
        },
        embedding,
      };
    });
  }

  /**
   * Supprime les chunks d'une source
   */
  deleteChunks(sourceId: string): void {
    this.db.prepare('DELETE FROM source_chunks WHERE source_id = ?').run(sourceId);
  }

  // MARK: - Hybrid Search (HNSW + BM25)

  /**
   * Hybrid search combining HNSW (dense) and BM25 (sparse) retrieval
   * Uses Reciprocal Rank Fusion for result combination
   */
  search(queryEmbedding: Float32Array, topK: number = 10, query?: string): PrimarySourceSearchResult[] {
    const startTime = Date.now();

    // DEBUG: Log index state at search time
    const dbChunkCount = (this.db.prepare('SELECT COUNT(*) as count FROM source_chunks WHERE embedding IS NOT NULL').get() as any).count;
    console.log(`🔍 [DEBUG] Search state: HNSW=${this.hnswCurrentSize}, BM25=${this.bm25ChunkMap.size}, DB chunks with embeddings=${dbChunkCount}`);

    // Check if indexes are out of sync with database
    const needsRebuild = this.hnswCurrentSize === 0 ||
      (dbChunkCount > 0 && Math.abs(this.hnswCurrentSize - dbChunkCount) > dbChunkCount * 0.1); // More than 10% difference

    if (needsRebuild) {
      console.log('📜 Primary sources: Indexes out of sync, rebuilding...');
      this.rebuildAllIndexes();

      if (this.hnswCurrentSize === 0) {
        console.log('⚠️ [DEBUG] After rebuild: still 0 chunks. DB has ' + dbChunkCount + ' chunks with embeddings');
        return [];
      }
    }

    const candidateSize = Math.max(topK * 5, 50);

    // 1. Dense retrieval (HNSW)
    const denseResults = this.searchHNSW(queryEmbedding, candidateSize);

    // 2. Sparse retrieval (BM25) - only if query text is provided
    let sparseResults: Array<{ chunk: PrimarySourceChunk; score: number }> = [];
    if (query && query.trim()) {
      sparseResults = this.searchBM25(query, candidateSize);
    }

    // 3. Fusion (RRF) or just dense if no sparse results
    let results: PrimarySourceSearchResult[];
    if (sparseResults.length > 0) {
      results = this.reciprocalRankFusion(denseResults, sparseResults, topK, query);
    } else {
      results = denseResults.slice(0, topK);
    }

    const duration = Date.now() - startTime;
    console.log(`🔍 Primary sources: Hybrid search found ${results.length} results in ${duration}ms (dense: ${denseResults.length}, sparse: ${sparseResults.length})`);

    return results;
  }

  /**
   * Search using HNSW index (fast approximate nearest neighbor)
   */
  private searchHNSW(queryEmbedding: Float32Array, k: number): PrimarySourceSearchResult[] {
    if (!this.hnswInitialized || !this.hnswIndex || this.hnswCurrentSize === 0) {
      return [];
    }

    this.hnswIndex.setEf(this.hnswEfSearch);

    const queryArray = Array.from(queryEmbedding);
    const result = this.hnswIndex.searchKnn(queryArray, Math.min(k, this.hnswCurrentSize));

    const searchResults: PrimarySourceSearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const similarity = 1 - result.distances[i]; // Convert distance to similarity

      const chunkId = this.hnswLabelMap.get(label);
      if (!chunkId) continue;

      // Get chunk from database
      const chunkRow = this.db.prepare('SELECT * FROM source_chunks WHERE id = ?').get(chunkId) as any;
      if (!chunkRow) continue;

      const chunk: PrimarySourceChunk = {
        id: chunkRow.id,
        sourceId: chunkRow.source_id,
        content: chunkRow.content,
        chunkIndex: chunkRow.chunk_index,
        startPosition: chunkRow.start_position,
        endPosition: chunkRow.end_position,
      };

      const source = this.getSource(chunk.sourceId);
      if (source) {
        searchResults.push({
          chunk,
          source,
          similarity,
          sourceType: 'primary',
        });
      }
    }

    return searchResults;
  }

  /**
   * Search using BM25 index (keyword-based)
   */
  private searchBM25(query: string, k: number): Array<{ chunk: PrimarySourceChunk; score: number }> {
    const processedQuery = this.preprocessTextForBM25(query);
    const queryTerms = processedQuery.split(/\s+/).filter(t => t.length > 0);

    if (queryTerms.length === 0 || this.bm25ChunkMap.size === 0) {
      return [];
    }

    // Update cache if needed
    if (this.bm25IsDirty) {
      this.updateBM25Cache();
    }

    const scores: Array<{ index: number; score: number; chunk: PrimarySourceChunk }> = [];

    this.bm25ChunkMap.forEach((chunk, docIndex) => {
      let score = 0;
      const doc = this.bm25Index.documents[docIndex];
      if (!doc) return;

      const docLength = Object.keys(doc).length;

      for (const term of queryTerms) {
        const termLower = term.toLowerCase();
        const tf = doc[termLower] || 0;

        if (tf === 0) continue;

        const idf = this.bm25IdfCache.get(termLower) || 0;

        // BM25 formula
        const numerator = tf * (this.bm25K1 + 1);
        const denominator = tf + this.bm25K1 * (1 - this.bm25B + this.bm25B * (docLength / this.bm25AvgDocLength));
        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ index: docIndex, score, chunk });
      }
    });

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(result => ({
        chunk: result.chunk,
        score: result.score,
      }));
  }

  /**
   * Reciprocal Rank Fusion to combine dense and sparse results
   * With exact match boosting for proper nouns and keywords
   */
  private reciprocalRankFusion(
    denseResults: PrimarySourceSearchResult[],
    sparseResults: Array<{ chunk: PrimarySourceChunk; score: number }>,
    k: number,
    originalQuery?: string
  ): PrimarySourceSearchResult[] {
    const scores = new Map<string, {
      chunk: PrimarySourceChunk;
      source: PrimarySourceDocument;
      denseScore: number;
      sparseScore: number;
      rrfScore: number;
      hasExactMatch: boolean;
    }>();

    // Extract potential keywords (words > 4 chars, likely proper nouns or significant terms)
    const queryKeywords = originalQuery
      ? originalQuery
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter(t => t.length > 4)
      : [];

    // Helper to check if chunk contains exact keyword matches
    const checkExactMatch = (content: string): boolean => {
      if (queryKeywords.length === 0) return false;
      const contentLower = content.toLowerCase();
      return queryKeywords.some(kw => contentLower.includes(kw));
    };

    // Add dense results
    denseResults.forEach((result, rank) => {
      const chunkId = result.chunk.id;
      const rrfScore = this.denseWeight * (1 / (this.rrfK + rank + 1));

      if (!scores.has(chunkId)) {
        scores.set(chunkId, {
          chunk: result.chunk,
          source: result.source,
          denseScore: result.similarity,
          sparseScore: 0,
          rrfScore: 0,
          hasExactMatch: checkExactMatch(result.chunk.content),
        });
      }

      const entry = scores.get(chunkId)!;
      entry.rrfScore += rrfScore;
    });

    // Add sparse results
    sparseResults.forEach((result, rank) => {
      const chunkId = result.chunk.id;
      const rrfScore = this.sparseWeight * (1 / (this.rrfK + rank + 1));

      if (!scores.has(chunkId)) {
        const source = this.getSource(result.chunk.sourceId);
        if (!source) return;

        scores.set(chunkId, {
          chunk: result.chunk,
          source,
          denseScore: 0,
          sparseScore: result.score,
          rrfScore: 0,
          hasExactMatch: checkExactMatch(result.chunk.content),
        });
      }

      const entry = scores.get(chunkId)!;
      entry.rrfScore += rrfScore;
      entry.sparseScore = result.score;
    });

    // Apply exact match boost (2x multiplier for chunks containing keywords)
    const EXACT_MATCH_BOOST = 2.0;
    let boostedCount = 0;
    scores.forEach((entry) => {
      if (entry.hasExactMatch) {
        entry.rrfScore *= EXACT_MATCH_BOOST;
        boostedCount++;
      }
    });

    if (boostedCount > 0) {
      console.log(`🎯 Primary sources: Boosted ${boostedCount} chunks with exact keyword matches`);
    }

    // Sort by RRF score and convert to results
    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, k)
      .map(entry => ({
        chunk: entry.chunk,
        source: entry.source,
        similarity: entry.rrfScore, // Use RRF score as similarity
        sourceType: 'primary' as const,
      }));
  }

  /**
   * Rebuild all indexes from database
   */
  rebuildAllIndexes(): void {
    console.log('🔨 Primary sources: Rebuilding all indexes...');
    const startTime = Date.now();

    // Clear existing indexes
    this.initNewHNSWIndex();
    this.bm25Index = new TfIdf();
    this.bm25ChunkMap.clear();

    // Get all chunks with embeddings
    const chunks = this.getAllChunksWithEmbeddings();

    console.log(`🔍 [DEBUG] rebuildAllIndexes: Found ${chunks.length} chunks from database`);

    if (chunks.length === 0) {
      console.log('⚠️ Primary sources: No chunks to index');
      // Additional debug: check if there are any chunks at all
      const totalChunks = (this.db.prepare('SELECT COUNT(*) as count FROM source_chunks').get() as any).count;
      const chunksWithEmbedding = (this.db.prepare('SELECT COUNT(*) as count FROM source_chunks WHERE embedding IS NOT NULL').get() as any).count;
      console.log(`🔍 [DEBUG] Total chunks: ${totalChunks}, with embedding: ${chunksWithEmbedding}`);
      return;
    }

    // Detect dimension from first valid embedding
    const firstValidEmbedding = chunks.find(c => c.embedding.length > 0);
    if (firstValidEmbedding && firstValidEmbedding.embedding.length !== this.hnswDimension) {
      console.log(`📏 Primary sources: Updating HNSW dimension from ${this.hnswDimension} to ${firstValidEmbedding.embedding.length}`);
      this.hnswDimension = firstValidEmbedding.embedding.length;
      this.initNewHNSWIndex();
    }

    // Add to HNSW
    let addedCount = 0;
    for (const { chunk, embedding } of chunks) {
      if (embedding.length > 0) {
        this.addToHNSWIndex(chunk.id, embedding);
        addedCount++;
      }
    }
    console.log(`🔨 Primary sources: Added ${addedCount} embeddings to HNSW index`)

    // Add to BM25
    let docIndex = 0;
    for (const { chunk } of chunks) {
      this.bm25Index.addDocument(this.preprocessTextForBM25(chunk.content));
      this.bm25ChunkMap.set(docIndex, chunk);
      docIndex++;
    }
    this.bm25IsDirty = true;

    // Save HNSW index
    this.saveHNSWIndex();

    const duration = Date.now() - startTime;
    console.log(`✅ Primary sources: Indexes rebuilt in ${duration}ms (${chunks.length} chunks)`);
  }

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
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  // MARK: - Statistics

  /**
   * Retourne les statistiques du store
   */
  getStatistics(): PrimarySourcesStatistics {
    const sourceCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM primary_sources').get() as any
    ).count;

    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM source_chunks').get() as any
    ).count;

    const photoCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM source_photos').get() as any
    ).count;

    const withTranscription = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM primary_sources WHERE transcription IS NOT NULL')
        .get() as any
    ).count;

    // Compter par archive
    const archiveRows = this.db
      .prepare(
        'SELECT archive, COUNT(*) as count FROM primary_sources WHERE archive IS NOT NULL GROUP BY archive'
      )
      .all() as any[];
    const byArchive: Record<string, number> = {};
    for (const row of archiveRows) {
      byArchive[row.archive] = row.count;
    }

    // Compter par collection
    const collectionRows = this.db
      .prepare(
        'SELECT collection, COUNT(*) as count FROM primary_sources WHERE collection IS NOT NULL GROUP BY collection'
      )
      .all() as any[];
    const byCollection: Record<string, number> = {};
    for (const row of collectionRows) {
      byCollection[row.collection] = row.count;
    }

    return {
      sourceCount,
      chunkCount,
      photoCount,
      withTranscription,
      withoutTranscription: sourceCount - withTranscription,
      byArchive,
      byCollection,
      tags: this.getAllTags(),
    };
  }

  // MARK: - Tropy Project Management

  /**
   * Enregistre un projet Tropy lié
   */
  saveTropyProject(tpyPath: string, name: string, autoSync: boolean = false): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(id, tpyPath, name, now, autoSync ? 1 : 0);

    return id;
  }

  /**
   * Met à jour la date de dernière sync
   */
  updateLastSync(tpyPath: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tropy_projects SET last_sync = ? WHERE tpy_path = ?').run(now, tpyPath);
  }

  /**
   * Récupère le projet Tropy enregistré
   */
  getTropyProject(): { id: string; tpyPath: string; name: string; lastSync: string; autoSync: boolean } | null {
    const row = this.db.prepare('SELECT * FROM tropy_projects LIMIT 1').get() as any;
    if (!row) return null;

    return {
      id: row.id,
      tpyPath: row.tpy_path,
      name: row.name,
      lastSync: row.last_sync,
      autoSync: row.auto_sync === 1,
    };
  }

  // MARK: - Entity CRUD

  /**
   * Saves an entity, returns existing ID if already exists
   */
  saveEntity(entity: Omit<Entity, 'id' | 'createdAt'>): string {
    const normalizedName = entityNormalizer.normalize(entity.name, entity.type as EntityType);

    // Check if entity already exists
    const existing = this.db
      .prepare('SELECT id FROM entities WHERE normalized_name = ? AND type = ?')
      .get(normalizedName, entity.type) as any;

    if (existing) {
      return existing.id;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO entities (id, name, type, normalized_name, aliases, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        entity.name,
        entity.type,
        normalizedName,
        entity.aliases ? JSON.stringify(entity.aliases) : null,
        now
      );

    return id;
  }

  /**
   * Saves an entity mention
   */
  saveEntityMention(mention: Omit<EntityMention, 'id'>): void {
    const id = randomUUID();

    this.db
      .prepare(`
        INSERT INTO entity_mentions (id, entity_id, chunk_id, source_id, start_position, end_position, context)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        mention.entityId,
        mention.chunkId || null,
        mention.sourceId,
        mention.startPosition || null,
        mention.endPosition || null,
        mention.context || null
      );
  }

  /**
   * Updates or creates a relation between two entities
   */
  updateEntityRelation(entity1Id: string, entity2Id: string, sourceId: string): void {
    // Ensure consistent ordering (smaller ID first)
    const [id1, id2] = entity1Id < entity2Id ? [entity1Id, entity2Id] : [entity2Id, entity1Id];

    const existing = this.db
      .prepare('SELECT weight, source_ids FROM entity_relations WHERE entity1_id = ? AND entity2_id = ?')
      .get(id1, id2) as any;

    if (existing) {
      // Update existing relation
      const sourceIds = JSON.parse(existing.source_ids || '[]') as string[];
      if (!sourceIds.includes(sourceId)) {
        sourceIds.push(sourceId);
      }

      this.db
        .prepare(`
          UPDATE entity_relations
          SET weight = weight + 1, source_ids = ?
          WHERE entity1_id = ? AND entity2_id = ?
        `)
        .run(JSON.stringify(sourceIds), id1, id2);
    } else {
      // Create new relation
      this.db
        .prepare(`
          INSERT INTO entity_relations (entity1_id, entity2_id, relation_type, weight, source_ids)
          VALUES (?, ?, 'co-occurrence', 1, ?)
        `)
        .run(id1, id2, JSON.stringify([sourceId]));
    }
  }

  /**
   * Saves entities extracted from a source and creates relations
   */
  saveEntitiesForSource(sourceId: string, entities: ExtractedEntity[], chunkId?: string): void {
    if (entities.length === 0) return;

    const entityIds: string[] = [];

    // Save each entity and its mention
    for (const extracted of entities) {
      const entityId = this.saveEntity({
        name: extracted.name,
        type: extracted.type,
        normalizedName: entityNormalizer.normalize(extracted.name, extracted.type),
      });

      entityIds.push(entityId);

      this.saveEntityMention({
        entityId,
        chunkId: chunkId || '',
        sourceId,
        startPosition: extracted.startPosition,
        endPosition: extracted.endPosition,
        context: extracted.context,
      });
    }

    // Create co-occurrence relations between all pairs of entities
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        this.updateEntityRelation(entityIds[i], entityIds[j], sourceId);
      }
    }
  }

  /**
   * Gets entities by name (fuzzy search)
   */
  getEntitiesByName(name: string, type?: EntityType): Entity[] {
    const normalizedName = entityNormalizer.normalize(name, type || 'PERSON');

    let query = 'SELECT * FROM entities WHERE normalized_name LIKE ?';
    const params: any[] = [`%${normalizedName}%`];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      normalizedName: row.normalized_name,
      aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
      createdAt: row.created_at,
    }));
  }

  /**
   * Gets all chunk IDs containing a specific entity
   */
  getChunkIdsWithEntity(entityId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT chunk_id FROM entity_mentions WHERE entity_id = ? AND chunk_id IS NOT NULL')
      .all(entityId) as any[];

    return rows.map(r => r.chunk_id);
  }

  /**
   * Gets related entities (by co-occurrence)
   */
  getRelatedEntities(entityId: string, limit: number = 10): Array<{ entity: Entity; weight: number }> {
    const rows = this.db
      .prepare(`
        SELECT e.*, er.weight
        FROM entities e
        JOIN entity_relations er ON (
          (er.entity1_id = ? AND er.entity2_id = e.id) OR
          (er.entity2_id = ? AND er.entity1_id = e.id)
        )
        ORDER BY er.weight DESC
        LIMIT ?
      `)
      .all(entityId, entityId, limit) as any[];

    return rows.map(row => ({
      entity: {
        id: row.id,
        name: row.name,
        type: row.type as EntityType,
        normalizedName: row.normalized_name,
        aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
        createdAt: row.created_at,
      },
      weight: row.weight,
    }));
  }

  /**
   * Deletes all entities for a source
   */
  deleteEntitiesForSource(sourceId: string): void {
    // Delete mentions for this source
    this.db.prepare('DELETE FROM entity_mentions WHERE source_id = ?').run(sourceId);

    // Clean up orphaned entities (no mentions left)
    this.db.exec(`
      DELETE FROM entities
      WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)
    `);

    // Clean up orphaned relations
    this.db.exec(`
      DELETE FROM entity_relations
      WHERE entity1_id NOT IN (SELECT id FROM entities)
         OR entity2_id NOT IN (SELECT id FROM entities)
    `);
  }

  /**
   * Gets entity statistics
   */
  getEntityStatistics(): EntityStatistics {
    const totalEntities = (this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as any).count;

    const byTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type')
      .all() as any[];

    const byType: Record<EntityType, number> = {
      PERSON: 0,
      LOCATION: 0,
      DATE: 0,
      ORGANIZATION: 0,
      EVENT: 0,
    };

    for (const row of byTypeRows) {
      byType[row.type as EntityType] = row.count;
    }

    const totalMentions = (this.db.prepare('SELECT COUNT(*) as count FROM entity_mentions').get() as any).count;
    const totalRelations = (this.db.prepare('SELECT COUNT(*) as count FROM entity_relations').get() as any).count;

    const topEntitiesRows = this.db
      .prepare(`
        SELECT e.*, COUNT(em.id) as mention_count
        FROM entities e
        JOIN entity_mentions em ON e.id = em.entity_id
        GROUP BY e.id
        ORDER BY mention_count DESC
        LIMIT 20
      `)
      .all() as any[];

    const topEntities = topEntitiesRows.map(row => ({
      entity: {
        id: row.id,
        name: row.name,
        type: row.type as EntityType,
        normalizedName: row.normalized_name,
        aliases: row.aliases ? JSON.parse(row.aliases) : undefined,
        createdAt: row.created_at,
      },
      mentionCount: row.mention_count,
    }));

    return {
      totalEntities,
      byType,
      totalMentions,
      totalRelations,
      topEntities,
    };
  }

  // MARK: - Entity-Boosted Search

  /**
   * Entity type weights for search scoring
   */
  private readonly entityTypeWeights: Record<EntityType, number> = {
    PERSON: 1.5,
    EVENT: 1.4,
    DATE: 1.3,
    LOCATION: 1.2,
    ORGANIZATION: 1.1,
  };

  /**
   * Search with entity boosting
   * Combines hybrid search with entity matching for improved relevance
   */
  searchWithEntityBoost(
    queryEmbedding: Float32Array,
    queryEntities: ExtractedEntity[],
    topK: number = 10,
    query?: string,
    hybridWeight: number = 0.7,
    entityWeight: number = 0.3
  ): PrimarySourceSearchResult[] {
    // 1. Get base hybrid search results (more candidates)
    const candidateSize = Math.max(topK * 3, 50);
    const baseResults = this.search(queryEmbedding, candidateSize, query);

    if (queryEntities.length === 0 || baseResults.length === 0) {
      return baseResults.slice(0, topK);
    }

    // 2. Find matching entities in the database
    const matchingEntityIds = new Map<string, { entityId: string; type: EntityType; score: number }>();

    for (const qEntity of queryEntities) {
      const matches = this.getEntitiesByName(qEntity.name, qEntity.type);
      for (const match of matches) {
        const isExact = entityNormalizer.areSameEntity(qEntity.name, match.name, qEntity.type);
        const score = isExact ? 1.0 : 0.7;
        matchingEntityIds.set(match.id, {
          entityId: match.id,
          type: match.type,
          score,
        });
      }
    }

    if (matchingEntityIds.size === 0) {
      return baseResults.slice(0, topK);
    }

    // 3. Get chunk IDs that contain these entities
    const chunkEntityScores = new Map<string, number>();

    for (const [entityId, { type, score }] of matchingEntityIds) {
      const chunkIds = this.getChunkIdsWithEntity(entityId);
      const typeWeight = this.entityTypeWeights[type] || 1.0;

      for (const chunkId of chunkIds) {
        const currentScore = chunkEntityScores.get(chunkId) || 0;
        chunkEntityScores.set(chunkId, currentScore + score * typeWeight);
      }
    }

    // 4. Combine scores
    const boostedResults = baseResults.map(result => {
      const entityScore = chunkEntityScores.get(result.chunk.id) || 0;
      const normalizedEntityScore = entityScore / queryEntities.length; // Normalize by query entity count

      const combinedScore =
        hybridWeight * result.similarity +
        entityWeight * normalizedEntityScore;

      return {
        ...result,
        similarity: combinedScore,
        entityScore: normalizedEntityScore,
      };
    });

    // 5. Re-sort by combined score and return top K
    boostedResults.sort((a, b) => b.similarity - a.similarity);

    console.log(`🏷️ [ENTITY-BOOST] Boosted ${boostedResults.filter(r => (r as any).entityScore > 0).length} results with entity matches`);

    return boostedResults.slice(0, topK);
  }

  // MARK: - Utilities

  private rowToDocument(row: any): PrimarySourceDocument {
    return {
      id: row.id,
      tropyId: row.tropy_id,
      title: row.title,
      date: row.date,
      creator: row.creator,
      archive: row.archive,
      collection: row.collection,
      type: row.type,
      transcription: row.transcription,
      transcriptionSource: row.transcription_source,
      language: row.language,
      lastModified: row.last_modified,
      indexedAt: row.indexed_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  /**
   * Retourne le chemin de la base de données
   */
  getDatabasePath(): string {
    return this.dbPath;
  }

  /**
   * Détecte la dimension des embeddings
   */
  getEmbeddingDimension(): number | null {
    const row = this.db
      .prepare('SELECT embedding FROM source_chunks WHERE embedding IS NOT NULL LIMIT 1')
      .get() as any;

    if (!row || !row.embedding) return null;

    return row.embedding.byteLength / 4; // Float32 = 4 bytes
  }

  /**
   * Ferme la connexion à la base de données
   */
  close(): void {
    // Save HNSW index before closing
    this.saveHNSWIndex();
    this.db.close();
    console.log('✅ Primary sources database closed');
  }

  /**
   * Clear HNSW index files (used when purging)
   */
  clearHNSWIndex(): void {
    if (existsSync(this.hnswIndexPath)) {
      unlinkSync(this.hnswIndexPath);
    }
    const metadataPath = this.hnswIndexPath + '.meta.json';
    if (existsSync(metadataPath)) {
      unlinkSync(metadataPath);
    }
    this.initNewHNSWIndex();
    this.bm25Index = new TfIdf();
    this.bm25ChunkMap.clear();
    this.bm25IsDirty = true;
    console.log('✅ Primary sources: HNSW and BM25 indexes cleared');
  }

  /**
   * Get index statistics
   */
  getIndexStats(): {
    hnswSize: number;
    bm25Size: number;
    hnswDimension: number;
  } {
    return {
      hnswSize: this.hnswCurrentSize,
      bm25Size: this.bm25ChunkMap.size,
      hnswDimension: this.hnswDimension,
    };
  }
}
