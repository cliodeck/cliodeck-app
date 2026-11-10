import Database from 'better-sqlite3';
import path from 'path';
import { existsSync, mkdirSync, chmodSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import hnswlib from 'hnswlib-node';
import natural from 'natural';
import type { PrimarySourceItem, PrimarySourcePhoto } from '../../integrations/tropy/TropyReader';
import type { ArchivalMetadata } from '../../types/archival-metadata';
import type {
  Entity,
  EntityType,
  EntityMention,
  ExtractedEntity,
  EntityStatistics,
  ENTITY_TYPE_WEIGHTS,
} from '../../types/entity';
import { entityNormalizer } from '../ner/EntityNormalizer';
import { relevanceScore } from '../rag/relevance';
import { sameFile } from './file-identity';

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
  transcriptionSource?: PrimarySourceItem['transcriptionSource'];
  /** Tesseract OCR confidence 0-100, if OCR was performed. */
  ocrConfidence?: number;
  /**
   * Notes Tropy de l'item, à côté de la transcription. `undefined` : ligne
   * écrite avant la colonne `notes_text` (la synchro l'initialise sans
   * réembarquer) ; '' : pas de note.
   */
  notesText?: string;
  /**
   * Longueur de la plus longue note Tropy de l'item, rognée (décision G1 :
   * c'est elle qui décide si les notes tiennent lieu de transcription).
   * `undefined` : ligne écrite avant la colonne `longest_note_length` (la
   * synchro l'initialise sans réembarquer) ; 0 : pas de note.
   */
  longestNoteLength?: number;
  /**
   * L'OCR de la source est à reprendre. 'poppler' : sa transcription ne porte
   * que les images de l'item, sans ses PDF ; elle n'est pas acquise. 'pages' :
   * les pages de l'item ont changé dans Tropy depuis l'OCR (photo arrivée d'un
   * autre item ou partie vers lui, G3) ; la transcription, complète, porte les
   * anciennes. La passe OCR suivante, sans forcer, la reprend. Absent : rien
   * en attente.
   */
  ocrPending?: OcrPending;
  /**
   * La transcription ne porte que les images de l'item : ses PDF attendaient
   * Poppler. Toujours vrai d'une source 'poppler' ; d'une source 'pages',
   * quand elle attendait Poppler avant que ses pages ne changent. Un corps
   * partiel n'est pas acquis : un nouveau texte partiel le remplace. Absent :
   * corps complet, ou pas de corps.
   */
  ocrPartial?: boolean;
  language?: string;
  lastModified: string;
  indexedAt: string;
  metadata?: Record<string, string>;
  /** Structured archival metadata — cote, fonds, repository, producer, … */
  archival?: ArchivalMetadata;
}

/** Pourquoi l'OCR d'une source est à reprendre (`PrimarySourceDocument.ocrPending`). */
export type OcrPending = 'poppler' | 'pages';

/**
 * `ocr_pending` d'une source 'pages' au corps partiel (`ocrPartial`) : elle
 * attendait Poppler quand ses pages ont changé. Rangée 'pages', elle passait
 * pour complète, et sa reprise sans Poppler jetait le nouveau texte partiel,
 * aux bonnes pages (revue de G3). Elle ne sort pas du magasin.
 */
const OCR_PENDING_PAGES_PARTIAL = 'pages-poppler';

/** La marque d'attente lue en base, telle que la synchro et le renderer la voient. */
function ocrPendingOf(value: unknown): Pick<PrimarySourceDocument, 'ocrPending' | 'ocrPartial'> {
  switch (value) {
    case 'poppler':
      return { ocrPending: 'poppler', ocrPartial: true };
    case 'pages':
      return { ocrPending: 'pages' };
    case OCR_PENDING_PAGES_PARTIAL:
      return { ocrPending: 'pages', ocrPartial: true };
    default:
      return {};
  }
}

/**
 * Version des extraits d'une source, écrite avec eux (`replaceSourceChunks`,
 * colonne `chunks_version`). Une source dont les extraits portent une version
 * inférieure, ou aucune, est « à réindexer » : `tropyService` les refait une
 * fois, en arrière-plan, à l'ouverture du projet (H7). À incrémenter à chaque
 * changement de ce que contiennent les extraits : découpage, en-tête, notes
 * (`indexableText` et `prepareSourceChunks` de `tropy-service`).
 *
 *  (aucune) — extraits écrits avant la marque. Leur en-tête est celui du
 *      premier embarquement : une source renommée dans Tropy avant L06-2 y
 *      garde son ancien titre ;
 *  1 — en-tête relu à chaque synchronisation (L06-2), extraits refaits une
 *      fois (H7).
 */
export const TROPY_CHUNKS_VERSION = 1;

/**
 * Ce que `saveSource` enregistre : la source lue dans Tropy, plus la longueur
 * de sa plus longue note, que le rapport de la source relit (G1).
 */
export type PrimarySourceRecord = PrimarySourceItem & Pick<PrimarySourceDocument, 'longestNoteLength'>;

export interface PrimarySourceChunk {
  id: string;
  sourceId: string;
  content: string;
  chunkIndex: number;
  startPosition: number;
  endPosition: number;
  /** Composite quality score 0-1 from ChunkQualityScorer. */
  qualityScore?: number;
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
  /** Les vecteurs écrits pendant `rebuildIndexesInSlices`, à rejouer dans le nouvel index. */
  private addedDuringRebuild: Array<{ chunkId: string; embedding: Float32Array }> | null = null;
  /** Fermé : une reconstruction par tranches en cours s'arrête sans rien remplacer. */
  private closed = false;

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
    // Tropy primary-source tables live in the shared brain.db (db-fusion step
    // 3) with `tropy_` prefixes to avoid colliding with the obsidian / PDF
    // domains. The HNSW binary index stays in its own file — it isn't SQLite.
    this.dbPath = path.join(projectPath, '.cliodeck', 'brain.db');
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
      // hnswlib relit un index écrit vide avec une capacité nulle : `close()`
      // en écrit un pour tout projet fermé sans extrait, et le premier ajout
      // levait alors, après l'écriture des extraits en base (trouvé par H7).
      // Le format du fichier ne change pas : seule la capacité en mémoire.
      if (this.hnswIndex.getMaxElements() < this.hnswMaxElements) {
        this.hnswIndex.resizeIndex(this.hnswMaxElements);
      }

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

    const rows = this.db.prepare('SELECT * FROM tropy_chunks').all() as any[];
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
    // brain.db est partagé entre plusieurs writers : attendre le verrou
    // plutôt qu'échouer en SQLITE_BUSY ; WAL posé explicitement pour ne
    // pas dépendre de l'ordre d'ouverture (#29).
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 3000');
  }

  /**
   * Drop and recreate every `tropy_*` table. Used by the "unlink Tropy
   * project" flow — post db-fusion we can no longer just delete the
   * underlying file (it now hosts history and other domains too).
   */
  purgeAll(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS tropy_entity_relations;
      DROP TABLE IF EXISTS tropy_entity_mentions;
      DROP TABLE IF EXISTS tropy_entities;
      DROP TABLE IF EXISTS tropy_chunks;
      DROP TABLE IF EXISTS tropy_photos;
      DROP TABLE IF EXISTS tropy_tags;
      DROP TABLE IF EXISTS tropy_sources;
      DROP TABLE IF EXISTS tropy_projects;
    `);
    this.createTables();
    // HNSW + BM25 are in-memory / parallel-file artifacts; reset them too.
    this.bm25IsDirty = true;
    this.bm25ChunkMap.clear();
    this.bm25IdfCache.clear();
    this.hnswLabelMap.clear();
    this.hnswCurrentSize = 0;
    this.hnswInitialized = false;
    if (existsSync(this.hnswIndexPath)) {
      try {
        unlinkSync(this.hnswIndexPath);
      } catch {
        /* best-effort */
      }
    }
  }

  private createTables(): void {
    // Table principale des sources primaires
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_sources (
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
        metadata TEXT,
        archival_metadata TEXT
      );
    `);

    // Soft migration: add archival_metadata column to pre-existing DBs
    // (installed before the archival-metadata schema landed). SQLite has no
    // IF NOT EXISTS for columns, so we guard with PRAGMA table_info.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'archival_metadata')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN archival_metadata TEXT');
        console.log('🗄️ Migrated tropy_sources: added archival_metadata column');
      }
    } catch (err) {
      console.warn('⚠️ archival_metadata migration check failed:', err);
    }

    // Soft migration: add ocr_confidence column (OCR quality report feature)
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'ocr_confidence')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN ocr_confidence REAL');
        console.log('🗄️ Migrated tropy_sources: added ocr_confidence column');
      }
    } catch (err) {
      console.warn('⚠️ ocr_confidence migration check failed:', err);
    }

    // Soft migration: add notes_text column (une note Tropy ne remplace plus
    // la transcription, elle est gardée à côté). NULL sur les lignes
    // existantes : la synchro suivante l'initialise sans réembarquer.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'notes_text')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN notes_text TEXT');
        console.log('🗄️ Migrated tropy_sources: added notes_text column');
      }
    } catch (err) {
      console.warn('⚠️ notes_text migration check failed:', err);
    }

    // Soft migration: add ocr_pending column. 'poppler' : la transcription
    // (OCR) ne porte que les images de l'item, ses PDF attendent Poppler ; la
    // passe OCR suivante la reprend (revue de L06-10). 'pages' : les pages de
    // l'item ont changé dans Tropy depuis l'OCR (G3) ; 'pages-poppler' : de
    // même, sur une transcription qui attendait Poppler. NULL : rien en
    // attente.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'ocr_pending')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN ocr_pending TEXT');
        console.log('🗄️ Migrated tropy_sources: added ocr_pending column');
      }
    } catch (err) {
      console.warn('⚠️ ocr_pending migration check failed:', err);
    }

    // Soft migration: add longest_note_length column. La plus longue note de
    // l'item décide si ses notes tiennent lieu de transcription (G1) ; le
    // rapport de la source le relit, `notes_text` joignant les notes. NULL sur
    // les lignes existantes : la synchro suivante l'initialise sans réembarquer.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'longest_note_length')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN longest_note_length INTEGER');
        console.log('🗄️ Migrated tropy_sources: added longest_note_length column');
      }
    } catch (err) {
      console.warn('⚠️ longest_note_length migration check failed:', err);
    }

    // Soft migration: add chunks_version column (`TROPY_CHUNKS_VERSION`, H7).
    // NULL sur les lignes existantes : leurs extraits sont d'avant la marque,
    // et la réindexation complète qui suit l'ouverture du projet les refait.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_sources')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'chunks_version')) {
        this.db.exec('ALTER TABLE tropy_sources ADD COLUMN chunks_version INTEGER');
        console.log('🗄️ Migrated tropy_sources: added chunks_version column');
      }
    } catch (err) {
      console.warn('⚠️ chunks_version migration check failed:', err);
    }

    // Table des photos associées aux sources
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_photos (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        mimetype TEXT,
        has_transcription INTEGER DEFAULT 0,
        transcription TEXT,
        FOREIGN KEY (source_id) REFERENCES tropy_sources(id) ON DELETE CASCADE
      );
    `);

    // Table des chunks avec embeddings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        start_position INTEGER NOT NULL,
        end_position INTEGER NOT NULL,
        embedding BLOB,
        FOREIGN KEY (source_id) REFERENCES tropy_sources(id) ON DELETE CASCADE
      );
    `);

    // Soft migration: add quality_score column to tropy_chunks
    try {
      const chunkCols = this.db
        .prepare("PRAGMA table_info('tropy_chunks')")
        .all() as Array<{ name: string }>;
      if (!chunkCols.some((c) => c.name === 'quality_score')) {
        this.db.exec('ALTER TABLE tropy_chunks ADD COLUMN quality_score REAL');
        console.log('🗄️ Migrated tropy_chunks: added quality_score column');
      }
    } catch (err) {
      console.warn('⚠️ quality_score migration check failed:', err);
    }

    // Table des tags (many-to-many)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_tags (
        source_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (source_id, tag),
        FOREIGN KEY (source_id) REFERENCES tropy_sources(id) ON DELETE CASCADE
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

    // Soft migration: add project_uuid column (`project.project_id` du .tpy,
    // l'identité du projet lié : les ids d'items et de photos sont locaux à
    // chaque .tpy). NULL sur les lignes existantes : tropyService.init le lit
    // dans le .tpy enregistré, sans réembarquer.
    try {
      const cols = this.db
        .prepare("PRAGMA table_info('tropy_projects')")
        .all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'project_uuid')) {
        this.db.exec('ALTER TABLE tropy_projects ADD COLUMN project_uuid TEXT');
        console.log('🗄️ Migrated tropy_projects: added project_uuid column');
      }
    } catch (err) {
      console.warn('⚠️ project_uuid migration check failed:', err);
    }

    // Indexes pour performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tropy_chunks_source ON tropy_chunks(source_id);
      CREATE INDEX IF NOT EXISTS idx_tropy_tags_tag ON tropy_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_tropy_photos_source ON tropy_photos(source_id);
      CREATE INDEX IF NOT EXISTS idx_tropy_sources_tropy_id ON tropy_sources(tropy_id);
      CREATE INDEX IF NOT EXISTS idx_tropy_sources_archive ON tropy_sources(archive);
      CREATE INDEX IF NOT EXISTS idx_tropy_sources_collection ON tropy_sources(collection);
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
      CREATE TABLE IF NOT EXISTS tropy_entities (
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
      CREATE INDEX IF NOT EXISTS idx_tropy_entities_normalized ON tropy_entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_tropy_entities_type ON tropy_entities(type);
      CREATE INDEX IF NOT EXISTS idx_tropy_entities_name ON tropy_entities(name);
    `);

    // Mentions d'entités dans les chunks
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_entity_mentions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        chunk_id TEXT,
        source_id TEXT NOT NULL,
        start_position INTEGER,
        end_position INTEGER,
        context TEXT,
        FOREIGN KEY (entity_id) REFERENCES tropy_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (source_id) REFERENCES tropy_sources(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tropy_entity_mentions_entity ON tropy_entity_mentions(entity_id);
      CREATE INDEX IF NOT EXISTS idx_tropy_entity_mentions_chunk ON tropy_entity_mentions(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_tropy_entity_mentions_source ON tropy_entity_mentions(source_id);
    `);

    // Relations entre entités (co-occurrences)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tropy_entity_relations (
        entity1_id TEXT NOT NULL,
        entity2_id TEXT NOT NULL,
        relation_type TEXT DEFAULT 'co-occurrence',
        weight INTEGER DEFAULT 1,
        source_ids TEXT,
        PRIMARY KEY (entity1_id, entity2_id),
        FOREIGN KEY (entity1_id) REFERENCES tropy_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (entity2_id) REFERENCES tropy_entities(id) ON DELETE CASCADE
      );
    `);

    console.log('✅ Entity tables created for Graph RAG');
  }

  // MARK: - Source CRUD

  /**
   * Sauvegarde une source primaire.
   *
   * UPSERT explicite, et non `INSERT OR REPLACE` : dans SQLite, REPLACE
   * SUPPRIME la ligne en conflit avant de réinsérer. Avec
   * `foreign_keys = ON` et quatre tables filles en `ON DELETE CASCADE`,
   * réenregistrer une source détruisait au passage ses chunks et ses
   * mentions d'entités — photos et tags, eux, sont réinsérés juste après,
   * ce qui masquait le problème. Une source réindexée sortait donc du RAG
   * en silence. Mesuré sur un projet réel : 46 chunks → 0 après une
   * simple resynchronisation.
   *
   * Tout ou rien : la ligne, ses photos et ses tags, dans une transaction.
   * Une écriture interrompue après la ligne gardait la nouvelle
   * transcription et sa date ; la passe suivante ne voyait plus rien à
   * changer et les extraits de l'ancien texte restaient pour de bon (L06-5).
   */
  saveSource(source: PrimarySourceRecord): string {
    return this.db.transaction(() => this.writeSource(source))();
  }

  private writeSource(source: PrimarySourceRecord): string {
    const id = source.id || randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO tropy_sources
      (id, tropy_id, title, date, creator, archive, collection, type,
       transcription, transcription_source, language, last_modified, indexed_at, metadata, archival_metadata, ocr_confidence,
       notes_text, longest_note_length)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tropy_id = excluded.tropy_id,
        title = excluded.title,
        date = excluded.date,
        creator = excluded.creator,
        archive = excluded.archive,
        collection = excluded.collection,
        type = excluded.type,
        transcription = excluded.transcription,
        transcription_source = excluded.transcription_source,
        language = excluded.language,
        last_modified = excluded.last_modified,
        indexed_at = excluded.indexed_at,
        metadata = excluded.metadata,
        archival_metadata = excluded.archival_metadata,
        ocr_confidence = excluded.ocr_confidence,
        notes_text = excluded.notes_text,
        longest_note_length = excluded.longest_note_length
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
      source.metadata ? JSON.stringify(source.metadata) : null,
      source.archival ? JSON.stringify(source.archival) : null,
      source.ocrConfidence ?? null,
      // '' se garde tel quel : il dit « pas de note », NULL « pas encore lu ».
      source.notesText ?? null,
      source.longestNoteLength ?? null
    );

    // Sauvegarder les photos
    this.saveSourcePhotos(id, source.photos);

    // Sauvegarder les tags
    this.saveSourceTags(id, source.tags);

    return id;
  }

  /**
   * Met à jour une source existante. Renvoie le nombre de lignes modifiées :
   * 0 pour une source absente, que l'appelant ne doit pas annoncer écrite.
   *
   * Une transcription qui n'est pas un OCR Tesseract n'a pas de confiance OCR :
   * celle de l'OCR qu'elle remplace restait sinon attachée à une saisie humaine
   * ou à un import, et le rapport du corpus la classait parmi les pires OCR.
   */
  updateSource(id: string, updates: Partial<PrimarySourceItem>): number {
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
      // Un texte écrit à la main, importé ou reconnu en entier remplace la
      // transcription partielle : plus rien n'est à reprendre.
      fields.push('ocr_pending = NULL');
    }
    if (updates.transcriptionSource !== undefined) {
      fields.push('transcription_source = ?');
      values.push(updates.transcriptionSource);
      fields.push('ocr_confidence = ?');
      values.push(updates.transcriptionSource === 'tesseract' ? (updates.ocrConfidence ?? null) : null);
    } else if (updates.ocrConfidence !== undefined) {
      fields.push('ocr_confidence = ?');
      values.push(updates.ocrConfidence);
    }
    if (updates.lastModified !== undefined) {
      fields.push('last_modified = ?');
      values.push(updates.lastModified.toISOString());
    }

    if (fields.length === 0) return 0;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE tropy_sources SET ${fields.join(', ')} WHERE id = ?`);
    const { changes } = stmt.run(...values);

    // Mettre à jour les tags si fournis
    if (updates.tags) {
      this.saveSourceTags(id, updates.tags);
    }
    return changes;
  }

  /**
   * Note qu'une transcription d'OCR est à reprendre — partielle, faute d'un
   * outil, ou faite sur des pages qui ont changé — ou qu'elle ne l'est plus.
   * `saveSource` n'y touche pas : la synchro, seule à réécrire la ligne
   * entière, l'appelle dans la même transaction. `partial` ne compte que pour
   * 'pages' (`ocrPartial`) : une source 'poppler' est toujours partielle.
   */
  setOcrPending(id: string, pending: OcrPending | null, partial = false): void {
    const value = pending === 'pages' && partial ? OCR_PENDING_PAGES_PARTIAL : pending;
    this.db.prepare('UPDATE tropy_sources SET ocr_pending = ? WHERE id = ?').run(value, id);
  }

  /**
   * Récupère une source par son ID
   */
  getSource(id: string): PrimarySourceDocument | null {
    const row = this.db.prepare('SELECT * FROM tropy_sources WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToDocument(row);
  }

  /**
   * Récupère une source par son ID Tropy
   */
  getSourceByTropyId(tropyId: number): PrimarySourceDocument | null {
    const row = this.db
      .prepare('SELECT * FROM tropy_sources WHERE tropy_id = ?')
      .get(tropyId) as any;
    if (!row) return null;
    return this.rowToDocument(row);
  }

  /**
   * Liste toutes les sources
   */
  getAllSources(): PrimarySourceDocument[] {
    const rows = this.db.prepare('SELECT * FROM tropy_sources ORDER BY title').all() as any[];
    return rows.map((row) => this.rowToDocument(row));
  }

  /**
   * Supprime une source
   */
  deleteSource(id: string): void {
    this.db.prepare('DELETE FROM tropy_sources WHERE id = ?').run(id);
  }

  /**
   * Vérifie si une source existe par son ID Tropy
   */
  sourceExistsByTropyId(tropyId: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM tropy_sources WHERE tropy_id = ?')
      .get(tropyId);
    return row !== undefined;
  }

  // MARK: - Photos

  private saveSourcePhotos(sourceId: string, photos: PrimarySourcePhoto[]): void {
    // Supprimer les photos existantes
    this.db.prepare('DELETE FROM tropy_photos WHERE source_id = ?').run(sourceId);

    // L'id est celui de la photo dans Tropy, qui le garde quand il la déplace
    // d'un item à l'autre (déplacement, fusion, scission) : encore rattachée
    // en base à l'item qui l'a perdue, la photo change de source au lieu de
    // lever UNIQUE. ON CONFLICT et non REPLACE, comme pour `tropy_sources`.
    const stmt = this.db.prepare(`
      INSERT INTO tropy_photos
      (id, source_id, path, filename, width, height, mimetype, has_transcription, transcription)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id,
        path = excluded.path,
        filename = excluded.filename,
        width = excluded.width,
        height = excluded.height,
        mimetype = excluded.mimetype,
        has_transcription = excluded.has_transcription,
        transcription = excluded.transcription
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
   * Les identifiants Tropy des photos de chaque source, par source, en une
   * requête. La synchro les relève avant sa passe pour voir quelles sources
   * ont changé de pages (G3) : `saveSource` réattribue en cours de passe la
   * photo qu'un item reçoit, et l'item qui l'a perdue, lu après, ne verrait
   * plus rien changer.
   */
  getPhotoIdsBySource(): Map<string, Set<number>> {
    const rows = this.db.prepare('SELECT id, source_id FROM tropy_photos').all() as Array<{
      id: number;
      source_id: string;
    }>;
    const bySource = new Map<string, Set<number>>();
    for (const row of rows) {
      const ids = bySource.get(row.source_id) ?? new Set<number>();
      ids.add(row.id);
      bySource.set(row.source_id, ids);
    }
    return bySource;
  }

  /**
   * Les sources, autres que `sourceId`, auxquelles la base attribue encore
   * une de ces photos : celles que `saveSource(sourceId)` leur retirera. La
   * synchro les marque dans la même transaction (G3).
   */
  getOtherPhotoOwners(sourceId: string, photoIds: readonly number[]): string[] {
    const ownerOf = this.db.prepare('SELECT source_id FROM tropy_photos WHERE id = ?');
    const owners = new Set<string>();
    for (const photoId of photoIds) {
      const row = ownerOf.get(photoId) as { source_id: string } | undefined;
      if (row && row.source_id !== sourceId) owners.add(row.source_id);
    }
    return [...owners];
  }

  /**
   * Récupère les photos d'une source
   */
  getSourcePhotos(sourceId: string): PrimarySourcePhoto[] {
    const rows = this.db
      .prepare('SELECT * FROM tropy_photos WHERE source_id = ?')
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
      .prepare('UPDATE tropy_photos SET transcription = ?, has_transcription = 1 WHERE id = ?')
      .run(transcription, photoId);
  }

  // MARK: - Tags

  private saveSourceTags(sourceId: string, tags: string[]): void {
    // Supprimer les tags existants
    this.db.prepare('DELETE FROM tropy_tags WHERE source_id = ?').run(sourceId);

    const stmt = this.db.prepare('INSERT INTO tropy_tags (source_id, tag) VALUES (?, ?)');
    for (const tag of tags) {
      stmt.run(sourceId, tag);
    }
  }

  /**
   * Récupère les tags d'une source
   */
  getSourceTags(sourceId: string): string[] {
    const rows = this.db
      .prepare('SELECT tag FROM tropy_tags WHERE source_id = ?')
      .all(sourceId) as any[];
    return rows.map((row) => row.tag);
  }

  /**
   * Liste tous les tags uniques
   */
  getAllTags(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT tag FROM tropy_tags ORDER BY tag').all() as any[];
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
      INSERT OR REPLACE INTO tropy_chunks
      (id, source_id, content, chunk_index, start_position, end_position, embedding, quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        chunk.id,
        chunk.sourceId,
        chunk.content,
        chunk.chunkIndex,
        chunk.startPosition,
        chunk.endPosition,
        embeddingBuffer,
        chunk.qualityScore ?? null
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
    this.addedDuringRebuild?.push({ chunkId, embedding });
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
      INSERT OR REPLACE INTO tropy_chunks
      (id, source_id, content, chunk_index, start_position, end_position, embedding, quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
          embeddingBuffer,
          chunk.qualityScore ?? null
        );
      }
    });

    transaction();
  }

  /**
   * Remplace tous les extraits d'une source par `items`, embarqués d'avance :
   * la suppression de l'ancien jeu et l'écriture du nouveau dans une seule
   * transaction. Une source a ainsi tous ses extraits ou aucun — un échec
   * d'embarquement au milieu laissait 9 extraits sur 10, et la synchro, qui ne
   * reprend que les sources sans extrait, ne complétait jamais le trou
   * (S08-1-30). `items` vide retire les extraits.
   *
   * La version des extraits (`TROPY_CHUNKS_VERSION`) s'écrit dans la même
   * transaction : la marque « à réindexer » d'une source ne tombe qu'avec
   * l'écriture de ses nouveaux extraits, et une passe interrompue laisse les
   * autres marquées (H7).
   *
   * INSERT simple, jamais `INSERT OR REPLACE` : les ids sont neufs, et un
   * conflit avec l'extrait d'une autre source doit échouer, pas le lui voler.
   * HNSW et BM25 ne sont alimentés qu'après la validation : une annulation ne
   * laisse rien en mémoire qui ne soit en base. À appeler hors d'une
   * transaction du magasin, sinon la validation n'est qu'un point de sauvegarde.
   */
  replaceSourceChunks(
    sourceId: string,
    items: Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }>
  ): void {
    const insert = this.db.prepare(`
      INSERT INTO tropy_chunks
      (id, source_id, content, chunk_index, start_position, end_position, embedding, quality_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let replaced = new Set<string>();
    this.db.transaction(() => {
      replaced = new Set(
        (this.db.prepare('SELECT id FROM tropy_chunks WHERE source_id = ?').all(sourceId) as Array<{ id: string }>).map(
          (row) => row.id
        )
      );
      this.db.prepare('DELETE FROM tropy_chunks WHERE source_id = ?').run(sourceId);
      this.markChunksCurrent(sourceId);
      for (const { chunk, embedding } of items) {
        insert.run(
          chunk.id,
          sourceId,
          chunk.content,
          chunk.chunkIndex,
          chunk.startPosition,
          chunk.endPosition,
          Buffer.from(embedding.buffer),
          chunk.qualityScore ?? null
        );
      }
    })();

    this.forgetIndexedChunks(replaced);
    for (const { chunk, embedding } of items) {
      this.addToHNSWIndex(chunk.id, embedding);
      this.addToBM25Index(chunk);
    }
  }

  /**
   * Retire des index en mémoire des extraits qui ne sont plus en base. BM25
   * servait encore leur texte (un ancien titre, une transcription corrigée), et
   * leurs vecteurs, comptés par la recherche, y déclenchaient une
   * reconstruction complète d'un bloc, une centaine de secondes sur 40 000
   * extraits (H7). Leurs points restent dans le graphe HNSW, que la recherche
   * ignore, jusqu'à la prochaine reconstruction.
   */
  private forgetIndexedChunks(chunkIds: ReadonlySet<string>): void {
    if (chunkIds.size === 0) return;
    for (const [label, chunkId] of this.hnswLabelMap) {
      if (chunkIds.has(chunkId)) this.hnswLabelMap.delete(label);
    }
    for (const [docIndex, chunk] of this.bm25ChunkMap) {
      if (chunkIds.has(chunk.id)) this.bm25ChunkMap.delete(docIndex);
    }
  }

  /**
   * Les sources dont les extraits sont d'une version antérieure à
   * `TROPY_CHUNKS_VERSION`, avec leur nombre d'extraits, dans l'ordre des
   * titres : ce que la réindexation complète doit refaire (H7). Une source
   * sans extrait n'y est pas : la synchro l'embarque, à la version courante.
   */
  listOutdatedChunkSources(): Array<{ id: string; chunks: number }> {
    return this.db
      .prepare(
        `SELECT s.id AS id, COUNT(c.id) AS chunks
         FROM tropy_sources s JOIN tropy_chunks c ON c.source_id = s.id
         WHERE s.chunks_version IS NULL OR s.chunks_version < ?
         GROUP BY s.id
         ORDER BY s.title, s.id`
      )
      .all(TROPY_CHUNKS_VERSION) as Array<{ id: string; chunks: number }>;
  }

  /**
   * Vrai si la source a des extraits d'une version antérieure : elle reste à
   * réindexer. Une autre écriture (synchro, transcription) a pu les refaire ou
   * les retirer depuis que la passe a dressé sa liste.
   */
  hasOutdatedChunks(sourceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM tropy_sources s
         WHERE s.id = ? AND (s.chunks_version IS NULL OR s.chunks_version < ?)
           AND EXISTS (SELECT 1 FROM tropy_chunks c WHERE c.source_id = s.id)`
      )
      .get(sourceId, TROPY_CHUNKS_VERSION);
    return row !== undefined;
  }

  /**
   * Les extraits de la source sont de la version courante. `replaceSourceChunks`
   * l'écrit avec eux ; la réindexation complète, seule, pour une source qui n'a
   * rien à embarquer (pas de transcription) : ses extraits sont gardés tels
   * quels, et elle n'est plus à réindexer.
   */
  markChunksCurrent(sourceId: string): void {
    this.db
      .prepare('UPDATE tropy_sources SET chunks_version = ? WHERE id = ?')
      .run(TROPY_CHUNKS_VERSION, sourceId);
  }

  /**
   * Récupère tous les chunks d'une source
   */
  getChunks(sourceId: string): PrimarySourceChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM tropy_chunks WHERE source_id = ? ORDER BY chunk_index')
      .all(sourceId) as any[];

    return rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      content: row.content,
      chunkIndex: row.chunk_index,
      startPosition: row.start_position,
      endPosition: row.end_position,
      qualityScore: row.quality_score ?? undefined,
    }));
  }

  /**
   * Récupère tous les chunks avec leurs embeddings
   */
  getAllChunksWithEmbeddings(): Array<{ chunk: PrimarySourceChunk; embedding: Float32Array }> {
    const rows = this.db.prepare('SELECT * FROM tropy_chunks').all() as any[];

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
    this.db.prepare('DELETE FROM tropy_chunks WHERE source_id = ?').run(sourceId);
  }

  /**
   * Exécute `fn` dans une transaction : tout ou rien. Synchrone, comme les
   * transactions de better-sqlite3 (qui refusent une fonction rendant une
   * promesse) : ni OCR, ni embeddings, ni lecture du .tpy à l'intérieur. Une
   * transaction du magasin appelée dedans devient un point de sauvegarde.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // MARK: - Hybrid Search (HNSW + BM25)

  /**
   * Hybrid search combining HNSW (dense) and BM25 (sparse) retrieval
   * Uses Reciprocal Rank Fusion for result combination
   */
  search(queryEmbedding: Float32Array, topK: number = 10, query?: string): PrimarySourceSearchResult[] {
    const startTime = Date.now();

    // DEBUG: Log index state at search time
    const dbChunkCount = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_chunks WHERE embedding IS NOT NULL').get() as any).count;
    console.log(`🔍 [DEBUG] Search state: HNSW=${this.hnswCurrentSize}, BM25=${this.bm25ChunkMap.size}, DB chunks with embeddings=${dbChunkCount}`);

    // Check if indexes are out of sync with database. Les vecteurs vivants
    // (`hnswLabelMap`), pas tous les points du graphe : un extrait remplacé y
    // laisse le sien jusqu'à la reconstruction (`forgetIndexedChunks`, H7).
    const needsRebuild = this.hnswCurrentSize === 0 ||
      (dbChunkCount > 0 && Math.abs(this.hnswLabelMap.size - dbChunkCount) > dbChunkCount * 0.1); // More than 10% difference

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
      const chunkRow = this.db.prepare('SELECT * FROM tropy_chunks WHERE id = ?').get(chunkId) as any;
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
      /** Rang lexical (1 = meilleur), `null` si l'extrait n'a été vu qu'en dense. */
      sparseRank: number | null;
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
          sparseRank: null,
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
          sparseRank: null,
          rrfScore: 0,
          hasExactMatch: checkExactMatch(result.chunk.content),
        });
      }

      const entry = scores.get(chunkId)!;
      entry.rrfScore += rrfScore;
      entry.sparseScore = result.score;
      entry.sparseRank = rank + 1;
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

    // Sort by RRF score (fusion's contribution to ordering) but expose
    // the dense cosine as `similarity` so downstream threshold filtering
    // (retrieval-service.ts, seuil ≈ 0.12) keeps its semantics. Returning
    // rrfScore as similarity made every chunk look unrelated — top-1 RRF
    // peaks near 1/(K+1) ≈ 0.016, far below any cosine threshold, so
    // everything got filtered and the fallback served the same 3 results
    // for every query. See HybridSearch.ts for the sibling fix.
    //
    // Path A′ : le cosinus seul ne suffisait pas. Un extrait trouvé
    // uniquement par BM25 — un nom propre dans un OCR, que le modèle
    // d'embedding ne connaît pas — portait `denseScore: 0` et se classait
    // derrière tout extrait sémantiquement voisin. Même contrat que les
    // PDF désormais : max(cosinus, pertinence du rang lexical).
    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, k)
      .map(entry => ({
        chunk: entry.chunk,
        source: entry.source,
        similarity: relevanceScore({
          dense: entry.denseScore,
          sparseRank: entry.sparseRank,
        }),
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
      const totalChunks = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_chunks').get() as any).count;
      const chunksWithEmbedding = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_chunks WHERE embedding IS NOT NULL').get() as any).count;
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

  /**
   * `rebuildAllIndexes` sans geler le processus principal (H7). Sur 40 650
   * extraits, la reconstruction d'un bloc dure une centaine de secondes, pendant
   * lesquelles ni l'éditeur ni le chat ne reçoivent de réponse. Ici, le nouvel
   * index HNSW se construit à côté, par tranches de `sliceSize` vecteurs, et
   * l'ancien sert les recherches entre deux ; les vecteurs écrits entre-temps
   * y sont rejoués, puis il le remplace. BM25, quelques secondes, se refait
   * d'un bloc à la fin, comme à l'ouverture du magasin.
   *
   * Rend faux, sans rien remplacer, si le magasin a été fermé en route.
   */
  async rebuildIndexesInSlices(sliceSize = 256): Promise<boolean> {
    const startTime = Date.now();
    const chunks = this.getAllChunksWithEmbeddings();
    const dimension = chunks.find((c) => c.embedding.length > 0)?.embedding.length ?? this.hnswDimension;
    const index = new HierarchicalNSW('cosine', dimension);
    index.initIndex(this.hnswMaxElements, this.hnswM, this.hnswEfConstruction);
    const labelMap = new Map<number, string>();
    const add = (chunkId: string, embedding: Float32Array): void => {
      if (embedding.length !== dimension || labelMap.size >= this.hnswMaxElements) return;
      index.addPoint(Array.from(embedding), labelMap.size);
      labelMap.set(labelMap.size, chunkId);
    };

    const writtenMeanwhile: Array<{ chunkId: string; embedding: Float32Array }> = [];
    this.addedDuringRebuild = writtenMeanwhile;
    try {
      for (let i = 0; i < chunks.length; i++) {
        add(chunks[i].chunk.id, chunks[i].embedding);
        if ((i + 1) % sliceSize === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (this.closed) return false;
        }
      }
      if (this.closed) return false;
      const included = new Set(labelMap.values());
      for (const { chunkId, embedding } of writtenMeanwhile) {
        if (!included.has(chunkId)) add(chunkId, embedding);
      }
    } finally {
      if (this.addedDuringRebuild === writtenMeanwhile) this.addedDuringRebuild = null;
    }

    this.hnswIndex = index;
    this.hnswLabelMap = labelMap;
    this.hnswCurrentSize = labelMap.size;
    this.hnswDimension = dimension;
    this.hnswInitialized = true;
    this.rebuildBM25Index();
    this.saveHNSWIndex();
    console.log(`✅ Primary sources: Indexes rebuilt in slices in ${Date.now() - startTime}ms (${labelMap.size} chunks)`);
    return true;
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
      this.db.prepare('SELECT COUNT(*) as count FROM tropy_sources').get() as any
    ).count;

    const chunkCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM tropy_chunks').get() as any
    ).count;

    const photoCount = (
      this.db.prepare('SELECT COUNT(*) as count FROM tropy_photos').get() as any
    ).count;

    const withTranscription = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM tropy_sources WHERE transcription IS NOT NULL')
        .get() as any
    ).count;

    // Compter par archive
    const archiveRows = this.db
      .prepare(
        'SELECT archive, COUNT(*) as count FROM tropy_sources WHERE archive IS NOT NULL GROUP BY archive'
      )
      .all() as any[];
    const byArchive: Record<string, number> = {};
    for (const row of archiveRows) {
      byArchive[row.archive] = row.count;
    }

    // Compter par collection
    const collectionRows = this.db
      .prepare(
        'SELECT collection, COUNT(*) as count FROM tropy_sources WHERE collection IS NOT NULL GROUP BY collection'
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
   * Enregistre le projet Tropy lié, une fois la garde d'identité passée
   * (`decideTropyBinding`) : il n'en reste qu'une ligne.
   *
   * La ligne gardée, avec son identifiant et sa surveillance, est celle que
   * la garde a reconnue (`keepId`) ; à défaut, celle du même projet
   * (`project_uuid`), puis celle du même fichier si elle n'appartient pas à
   * un autre projet connu. Un projet déplacé met ainsi à jour son chemin au
   * lieu d'ajouter une ligne — y compris quand seule l'empreinte des photos
   * l'a reconnu, ligne sans uuid et ancien chemin disparu : ni l'uuid ni le
   * chemin ne la retrouvent alors, d'où `keepId`. Les autres lignes sont
   * retirées — doublons de l'ancien `saveTropyProject`, qui en ajoutait une
   * par synchronisation, ou lien d'un projet sans source qu'on remplace. Le
   * « une seule » est la règle de la v1 (Q25), décidée ici et dans
   * `decideTropyBinding` ; le schéma n'interdit pas plusieurs lignes.
   *
   * UPSERT, jamais `INSERT OR REPLACE` (A5) : REPLACE supprime la ligne en
   * conflit et la réécrit avec les seules colonnes nommées. Un appel qui ne
   * connaît pas l'uuid (identité illisible) n'efface pas celui qui est
   * enregistré.
   *
   * `autoSync` omis = « ne touche pas au réglage existant » : la synchro
   * appelle cette méthode à chaque passe et ne doit pas désactiver au
   * passage la surveillance que l'utilisateur a activée.
   *
   * `keepId` omis sur une première liaison, exprès : un autre projet ne
   * reprend pas les réglages de la ligne qu'il remplace.
   */
  bindTropyProject(
    tpyPath: string,
    name: string,
    projectUuid: string | null,
    options: { autoSync?: boolean; keepId?: string | null } = {}
  ): string {
    const { autoSync, keepId } = options;
    const now = new Date().toISOString();

    const rows = this.db
      .prepare(
        'SELECT id, tpy_path, project_uuid, auto_sync FROM tropy_projects ORDER BY last_sync DESC'
      )
      .all() as Array<{ id: string; tpy_path: string; project_uuid: string | null; auto_sync: number }>;

    const kept =
      (keepId ? rows.find((r) => r.id === keepId) : undefined) ??
      (projectUuid ? rows.find((r) => r.project_uuid === projectUuid) : undefined) ??
      rows.find(
        (r) =>
          (!projectUuid || !r.project_uuid || r.project_uuid === projectUuid) &&
          sameFile(r.tpy_path, tpyPath)
      );
    const id = kept?.id ?? randomUUID();
    const effectiveAutoSync = autoSync ?? kept?.auto_sync === 1;

    this.db.transaction(() => {
      const removed = this.db.prepare('DELETE FROM tropy_projects WHERE id != ?').run(id).changes;
      if (removed > 0) {
        console.log(`🧹 [PRIMARY-STORE] Removed ${removed} other Tropy project row(s)`);
      }
      this.db
        .prepare(
          `
      INSERT INTO tropy_projects (id, tpy_path, name, last_sync, auto_sync, project_uuid)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tpy_path = excluded.tpy_path,
        name = excluded.name,
        last_sync = excluded.last_sync,
        auto_sync = excluded.auto_sync,
        project_uuid = COALESCE(excluded.project_uuid, tropy_projects.project_uuid)
    `
        )
        .run(id, tpyPath, name, now, effectiveAutoSync ? 1 : 0, projectUuid);
    })();

    return id;
  }

  /**
   * Complète l'identité d'une ligne d'avant `project_uuid`, lue dans le .tpy
   * enregistré, sans rien toucher d'autre : `last_sync` décide encore si une
   * synchronisation est à refaire (`checkSyncNeeded`).
   */
  recordTropyProjectUuid(id: string, projectUuid: string): void {
    this.db
      .prepare('UPDATE tropy_projects SET project_uuid = ? WHERE id = ? AND project_uuid IS NULL')
      .run(projectUuid, id);
  }

  /**
   * Couples (id de photo, nom de fichier) des sources enregistrées : de quoi
   * reconnaître le projet lié quand ni son identité ni son chemin ne le
   * peuvent plus (ligne d'avant `project_uuid`, projet déplacé depuis).
   */
  getPhotoFingerprint(limit: number): Array<{ id: number; filename: string }> {
    return this.db
      .prepare('SELECT id, filename FROM tropy_photos ORDER BY id LIMIT ?')
      .all(limit) as Array<{ id: number; filename: string }>;
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
  getTropyProject(): {
    id: string;
    tpyPath: string;
    name: string;
    lastSync: string;
    autoSync: boolean;
    /** `project.project_id` du .tpy lié ; `null` sur une ligne d'avant la colonne. */
    projectUuid: string | null;
  } | null {
    // `LIMIT 1` sans `ORDER BY` rendait une ligne arbitraire — sans
    // conséquence tant qu'il n'y en a qu'une, mais c'est précisément ce
    // qu'on ne peut pas garantir sur les bases déjà polluées de doublons.
    const row = this.db
      .prepare('SELECT * FROM tropy_projects ORDER BY last_sync DESC LIMIT 1')
      .get() as any;
    if (!row) return null;

    return {
      id: row.id,
      tpyPath: row.tpy_path,
      name: row.name,
      lastSync: row.last_sync,
      autoSync: row.auto_sync === 1,
      projectUuid: row.project_uuid ?? null,
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
      .prepare('SELECT id FROM tropy_entities WHERE normalized_name = ? AND type = ?')
      .get(normalizedName, entity.type) as any;

    if (existing) {
      return existing.id;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO tropy_entities (id, name, type, normalized_name, aliases, created_at)
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
        INSERT INTO tropy_entity_mentions (id, entity_id, chunk_id, source_id, start_position, end_position, context)
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
      .prepare('SELECT weight, source_ids FROM tropy_entity_relations WHERE entity1_id = ? AND entity2_id = ?')
      .get(id1, id2) as any;

    if (existing) {
      // Update existing relation
      const sourceIds = JSON.parse(existing.source_ids || '[]') as string[];
      if (!sourceIds.includes(sourceId)) {
        sourceIds.push(sourceId);
      }

      this.db
        .prepare(`
          UPDATE tropy_entity_relations
          SET weight = weight + 1, source_ids = ?
          WHERE entity1_id = ? AND entity2_id = ?
        `)
        .run(JSON.stringify(sourceIds), id1, id2);
    } else {
      // Create new relation
      this.db
        .prepare(`
          INSERT INTO tropy_entity_relations (entity1_id, entity2_id, relation_type, weight, source_ids)
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

    let query = 'SELECT * FROM tropy_entities WHERE normalized_name LIKE ?';
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
      .prepare('SELECT DISTINCT chunk_id FROM tropy_entity_mentions WHERE entity_id = ? AND chunk_id IS NOT NULL')
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
        FROM tropy_entities e
        JOIN tropy_entity_relations er ON (
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
    this.db.prepare('DELETE FROM tropy_entity_mentions WHERE source_id = ?').run(sourceId);

    // Clean up orphaned entities (no mentions left)
    this.db.exec(`
      DELETE FROM tropy_entities
      WHERE id NOT IN (SELECT DISTINCT entity_id FROM tropy_entity_mentions)
    `);

    // Clean up orphaned relations
    this.db.exec(`
      DELETE FROM tropy_entity_relations
      WHERE entity1_id NOT IN (SELECT id FROM tropy_entities)
         OR entity2_id NOT IN (SELECT id FROM tropy_entities)
    `);
  }

  /**
   * Gets entity statistics
   */
  getEntityStatistics(): EntityStatistics {
    const totalEntities = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_entities').get() as any).count;

    const byTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM tropy_entities GROUP BY type')
      .all() as any[];

    const byType: Record<EntityType, number> = {
      PERSON: 0,
      LOCATION: 0,
      DATE: 0,
      ORGANIZATION: 0,
      EVENT: 0,
      CONCEPT: 0,
    };

    for (const row of byTypeRows) {
      byType[row.type as EntityType] = row.count;
    }

    const totalMentions = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_entity_mentions').get() as any).count;
    const totalRelations = (this.db.prepare('SELECT COUNT(*) as count FROM tropy_entity_relations').get() as any).count;

    const topEntitiesRows = this.db
      .prepare(`
        SELECT e.*, COUNT(em.id) as mention_count
        FROM tropy_entities e
        JOIN tropy_entity_mentions em ON e.id = em.entity_id
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
    CONCEPT: 1.0,
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
      archival: row.archival_metadata ? JSON.parse(row.archival_metadata) : undefined,
      ocrConfidence: row.ocr_confidence ?? undefined,
      notesText: row.notes_text ?? undefined,
      longestNoteLength: row.longest_note_length ?? undefined,
      ...ocrPendingOf(row.ocr_pending),
    };
  }

  /**
   * Retourne le chemin de la base de données
   */
  getDatabasePath(): string {
    return this.dbPath;
  }

  // MARK: - OCR Quality Reports

  /**
   * Per-document OCR quality report.
   */
  getSourceOCRReport(sourceId: string): {
    sourceId: string;
    title: string;
    ocrConfidence: number | null;
    transcriptionSource: string | null;
    chunkCount: number;
    avgQualityScore: number | null;
    minQualityScore: number | null;
    maxQualityScore: number | null;
    transcriptionLength: number;
    /** Plus longue note Tropy de la source (G1) ; null : pas encore relue par la synchro. */
    longestNoteLength: number | null;
  } | null {
    const source = this.getSource(sourceId);
    if (!source) return null;

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as chunk_count,
        AVG(quality_score) as avg_quality,
        MIN(quality_score) as min_quality,
        MAX(quality_score) as max_quality
      FROM tropy_chunks WHERE source_id = ?
    `).get(sourceId) as { chunk_count: number; avg_quality: number | null; min_quality: number | null; max_quality: number | null };

    return {
      sourceId,
      title: source.title,
      ocrConfidence: source.ocrConfidence ?? null,
      transcriptionSource: source.transcriptionSource ?? null,
      chunkCount: row.chunk_count,
      avgQualityScore: row.avg_quality,
      minQualityScore: row.min_quality,
      maxQualityScore: row.max_quality,
      transcriptionLength: source.transcription?.length ?? 0,
      longestNoteLength: source.longestNoteLength ?? null,
    };
  }

  /**
   * Corpus-wide OCR quality report.
   */
  getCorpusOCRReport(): {
    totalSources: number;
    sourcesWithOCR: number;
    sourcesWithTranscription: number;
    avgOCRConfidence: number | null;
    confidenceDistribution: { bucket: string; count: number }[];
    avgChunkQuality: number | null;
    totalChunks: number;
    chunksWithQuality: number;
    worstSources: Array<{ id: string; title: string; ocrConfidence: number }>;
    bestSources: Array<{ id: string; title: string; ocrConfidence: number }>;
    byTranscriptionSource: Record<string, number>;
  } {
    const totalSources = (this.db.prepare('SELECT COUNT(*) as c FROM tropy_sources').get() as { c: number }).c;
    const sourcesWithOCR = (this.db.prepare('SELECT COUNT(*) as c FROM tropy_sources WHERE ocr_confidence IS NOT NULL').get() as { c: number }).c;
    const sourcesWithTranscription = (this.db.prepare("SELECT COUNT(*) as c FROM tropy_sources WHERE transcription IS NOT NULL AND transcription != ''").get() as { c: number }).c;
    const avgOCR = (this.db.prepare('SELECT AVG(ocr_confidence) as v FROM tropy_sources WHERE ocr_confidence IS NOT NULL').get() as { v: number | null }).v;

    // Confidence distribution in buckets: 0-20, 20-40, 40-60, 60-80, 80-100
    const buckets: { bucket: string; count: number }[] = [];
    for (const [label, low, high] of [
      ['0-20', 0, 20], ['20-40', 20, 40], ['40-60', 40, 60], ['60-80', 60, 80], ['80-100', 80, 101],
    ] as [string, number, number][]) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as c FROM tropy_sources WHERE ocr_confidence >= ? AND ocr_confidence < ?'
      ).get(low, high) as { c: number };
      buckets.push({ bucket: label, count: row.c });
    }

    // Chunk quality stats
    const chunkStats = this.db.prepare(`
      SELECT COUNT(*) as total, COUNT(quality_score) as with_quality, AVG(quality_score) as avg_quality
      FROM tropy_chunks
    `).get() as { total: number; with_quality: number; avg_quality: number | null };

    // Worst 5 sources by OCR confidence
    const worstRows = this.db.prepare(
      'SELECT id, title, ocr_confidence FROM tropy_sources WHERE ocr_confidence IS NOT NULL ORDER BY ocr_confidence ASC LIMIT 5'
    ).all() as Array<{ id: string; title: string; ocr_confidence: number }>;

    // Best 5 sources
    const bestRows = this.db.prepare(
      'SELECT id, title, ocr_confidence FROM tropy_sources WHERE ocr_confidence IS NOT NULL ORDER BY ocr_confidence DESC LIMIT 5'
    ).all() as Array<{ id: string; title: string; ocr_confidence: number }>;

    // By transcription source
    const srcRows = this.db.prepare(
      "SELECT transcription_source, COUNT(*) as c FROM tropy_sources WHERE transcription_source IS NOT NULL GROUP BY transcription_source"
    ).all() as Array<{ transcription_source: string; c: number }>;
    const byTranscriptionSource: Record<string, number> = {};
    for (const r of srcRows) {
      byTranscriptionSource[r.transcription_source] = r.c;
    }

    return {
      totalSources,
      sourcesWithOCR,
      sourcesWithTranscription,
      avgOCRConfidence: avgOCR,
      confidenceDistribution: buckets,
      avgChunkQuality: chunkStats.avg_quality,
      totalChunks: chunkStats.total,
      chunksWithQuality: chunkStats.with_quality,
      worstSources: worstRows.map(r => ({ id: r.id, title: r.title, ocrConfidence: r.ocr_confidence })),
      bestSources: bestRows.map(r => ({ id: r.id, title: r.title, ocrConfidence: r.ocr_confidence })),
      byTranscriptionSource,
    };
  }

  /**
   * Détecte la dimension des embeddings
   */
  getEmbeddingDimension(): number | null {
    const row = this.db
      .prepare('SELECT embedding FROM tropy_chunks WHERE embedding IS NOT NULL LIMIT 1')
      .get() as any;

    if (!row || !row.embedding) return null;

    return row.embedding.byteLength / 4; // Float32 = 4 bytes
  }

  /**
   * Ferme la connexion à la base de données
   */
  close(): void {
    this.closed = true;
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
