import hnswlib from 'hnswlib-node';
import type { SearchResult, DocumentChunk } from '../../types/pdf-document';
import * as path from 'path';
import * as fs from 'fs';

const { HierarchicalNSW } = hnswlib;
type HierarchicalNSW = InstanceType<typeof HierarchicalNSW>;

// Minimum valid index file size (empty index is at least a few KB)
const MIN_INDEX_FILE_SIZE = 1024;

// Result of HNSW initialization
export interface HNSWInitResult {
  success: boolean;
  loaded: boolean; // true if existing index was loaded, false if new index created
  corrupted: boolean; // true if existing index was corrupted and needs rebuild
  error?: string;
}

/**
 * HNSW-based vector store for fast approximate nearest neighbor search
 *
 * Performance characteristics:
 * - Memory: ~500 MB for 50k chunks (768-dim vectors)
 * - Search time: O(log n) - typically 10-20ms for 50k chunks
 * - Index build time: O(n log n) - about 1-2s per 1000 chunks
 *
 * Configuration:
 * - M=16: Number of bi-directional links per node (trade-off: memory vs accuracy)
 * - efConstruction=100: Size of dynamic candidate list during construction
 * - efSearch=50: Size of dynamic candidate list during search (configurable)
 */
export class HNSWVectorStore {
  private index: HierarchicalNSW | null = null;
  private dimension: number;
  private maxElements: number;
  private indexPath: string;
  private chunkIdMap: Map<number, string>; // HNSW label -> chunk ID
  private chunkDataMap: Map<string, DocumentChunk>; // chunk ID -> chunk data
  private isInitialized: boolean = false;
  private currentSize: number = 0;
  private wasCorrupted: boolean = false; // Track if corruption was detected

  // HNSW parameters
  private readonly M = 16; // Number of connections per layer (default: 16)
  private readonly efConstruction = 100; // Construction-time accuracy (default: 200, reduced for RAM)
  private efSearch = 50; // Search-time accuracy (default: 50)

  constructor(
    projectPath: string,
    dimension: number = 768,
    maxElements: number = 100000
  ) {
    this.dimension = dimension;
    this.maxElements = maxElements;
    this.indexPath = path.join(projectPath, '.cliodeck', 'hnsw.index');
    this.chunkIdMap = new Map();
    this.chunkDataMap = new Map();
  }

  /**
   * Check if an index file appears to be valid (basic integrity check)
   * This helps prevent SIGSEGV crashes from corrupted files
   */
  private validateIndexFile(filePath: string): { valid: boolean; reason?: string } {
    try {
      if (!fs.existsSync(filePath)) {
        return { valid: false, reason: 'File does not exist' };
      }

      const stats = fs.statSync(filePath);

      // Check minimum file size
      if (stats.size < MIN_INDEX_FILE_SIZE) {
        return { valid: false, reason: `File too small (${stats.size} bytes, minimum ${MIN_INDEX_FILE_SIZE})` };
      }

      // Check if file is readable
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(16);
      fs.readSync(fd, buffer, 0, 16, 0);
      fs.closeSync(fd);

      return { valid: true };
    } catch (error) {
      return { valid: false, reason: `File access error: ${error.message}` };
    }
  }

  /**
   * Check if the index was detected as corrupted during initialization
   */
  wasIndexCorrupted(): boolean {
    return this.wasCorrupted;
  }

  /**
   * Initialize or load existing HNSW index
   * Returns detailed result for caller to handle recovery if needed
   */
  async initialize(): Promise<HNSWInitResult> {
    if (this.isInitialized) {
      return { success: true, loaded: true, corrupted: false };
    }

    this.index = new HierarchicalNSW('cosine', this.dimension);

    // Try to load existing index
    if (fs.existsSync(this.indexPath)) {
      // Validate file before attempting to load (prevents SIGSEGV)
      const validation = this.validateIndexFile(this.indexPath);

      if (!validation.valid) {
        console.warn(`⚠️  HNSW index file invalid: ${validation.reason}`);
        console.warn('🔄 Deleting corrupted index and creating new one...');
        this.wasCorrupted = true;

        // Safely delete corrupted file
        try {
          fs.unlinkSync(this.indexPath);
          const metadataPath = this.indexPath + '.meta.json';
          if (fs.existsSync(metadataPath)) {
            fs.unlinkSync(metadataPath);
          }
        } catch (deleteError) {
          console.error('❌ Failed to delete corrupted index:', deleteError);
        }

        // Create new index
        this.index.initIndex(this.maxElements, this.M, this.efConstruction);
        this.isInitialized = true;
        return { success: true, loaded: false, corrupted: true, error: validation.reason };
      }

      try {
        console.log('📂 Loading existing HNSW index from', this.indexPath);
        this.index.readIndexSync(this.indexPath);
        this.currentSize = this.index.getCurrentCount();
        console.log(`✅ HNSW index loaded: ${this.currentSize} vectors`);
        this.isInitialized = true;
        return { success: true, loaded: true, corrupted: false };
      } catch (error) {
        // Native code threw an error (but didn't crash with SIGSEGV)
        console.warn('⚠️  Failed to load HNSW index:', error.message);
        console.warn('🔄 Deleting corrupted index and creating new one...');
        this.wasCorrupted = true;

        // Safely delete corrupted file
        try {
          fs.unlinkSync(this.indexPath);
          const metadataPath = this.indexPath + '.meta.json';
          if (fs.existsSync(metadataPath)) {
            fs.unlinkSync(metadataPath);
          }
        } catch (deleteError) {
          console.error('❌ Failed to delete corrupted index:', deleteError);
        }

        // Create new index
        this.index.initIndex(this.maxElements, this.M, this.efConstruction);
        this.isInitialized = true;
        return { success: true, loaded: false, corrupted: true, error: error.message };
      }
    } else {
      console.log('🆕 Creating new HNSW index');
      this.index.initIndex(this.maxElements, this.M, this.efConstruction);
      this.isInitialized = true;
      return { success: true, loaded: false, corrupted: false };
    }
  }

  /**
   * Add a chunk with its embedding to the index
   */
  async addChunk(chunk: DocumentChunk, embedding: Float32Array): Promise<void> {
    if (!this.isInitialized || !this.index) {
      await this.initialize();
    }

    if (this.currentSize >= this.maxElements) {
      throw new Error(`HNSW index is full (max ${this.maxElements} elements)`);
    }

    // Validate embedding dimension
    if (embedding.length !== this.dimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimension}, but got ${embedding.length}. ` +
        `This usually happens when the embedding model has changed. ` +
        `Please regenerate embeddings with the current model.`
      );
    }

    // Validate embedding values (check for NaN/Infinity which can crash native code)
    for (let i = 0; i < embedding.length; i++) {
      if (!Number.isFinite(embedding[i])) {
        throw new Error(
          `Invalid embedding value at index ${i}: ${embedding[i]}. ` +
          `Embeddings must contain finite numbers only.`
        );
      }
    }

    const label = this.currentSize;
    // Convert Float32Array to number[]
    const embeddingArray = Array.from(embedding);

    try {
      this.index!.addPoint(embeddingArray, label);
    } catch (error) {
      throw new Error(`Failed to add point to HNSW index: ${error.message}`);
    }

    this.chunkIdMap.set(label, chunk.id);
    this.chunkDataMap.set(chunk.id, chunk);
    this.currentSize++;
  }

  /**
   * Batch add chunks (more efficient than adding one by one)
   */
  async addChunks(chunks: Array<{ chunk: DocumentChunk; embedding: Float32Array }>): Promise<void> {
    console.log(`📥 [HNSW] addChunks called with ${chunks.length} chunks`);
    console.log(`📥 [HNSW] Index state: initialized=${this.isInitialized}, hasIndex=${!!this.index}, currentSize=${this.currentSize}`);

    if (!this.isInitialized || !this.index) {
      console.log(`📥 [HNSW] Initializing index...`);
      await this.initialize();
      console.log(`📥 [HNSW] Index initialized`);
    }

    console.log(`📥 [HNSW] Index parameters: dimension=${this.dimension}, maxElements=${this.maxElements}`);
    console.log(`📥 Adding ${chunks.length} chunks to HNSW index...`);
    const startTime = Date.now();
    let addedCount = 0;
    let skippedCount = 0;

    for (let idx = 0; idx < chunks.length; idx++) {
      const { chunk, embedding } = chunks[idx];
      if (this.currentSize >= this.maxElements) {
        console.warn(`⚠️  HNSW index full, stopping at ${this.currentSize} chunks`);
        break;
      }

      // Validate embedding dimension
      if (embedding.length !== this.dimension) {
        console.warn(
          `⚠️  Skipping chunk ${chunk.id}: dimension mismatch (expected ${this.dimension}, got ${embedding.length})`
        );
        skippedCount++;
        continue;
      }

      // Validate embedding values (check for NaN/Infinity which can crash native code)
      let hasInvalidValue = false;
      for (let i = 0; i < embedding.length; i++) {
        if (!Number.isFinite(embedding[i])) {
          console.warn(`⚠️  Skipping chunk ${chunk.id}: invalid embedding value at index ${i}`);
          hasInvalidValue = true;
          skippedCount++;
          break;
        }
      }
      if (hasInvalidValue) continue;

      const label = this.currentSize;
      // Convert Float32Array to number[]
      const embeddingArray = Array.from(embedding);

      // Log first few points for debugging
      if (idx < 3 || idx === chunks.length - 1) {
        console.log(`📥 [HNSW] About to add point ${idx + 1}/${chunks.length}: label=${label}, embeddingLength=${embeddingArray.length}`);
      }

      try {
        this.index!.addPoint(embeddingArray, label);
        this.chunkIdMap.set(label, chunk.id);
        this.chunkDataMap.set(chunk.id, chunk);
        this.currentSize++;
        addedCount++;

        if (idx < 3 || idx === chunks.length - 1) {
          console.log(`📥 [HNSW] Point ${idx + 1} added successfully`);
        }
      } catch (error: any) {
        console.warn(`⚠️  Failed to add chunk ${chunk.id}: ${error.message}`);
        skippedCount++;
      }
    }

    const duration = Date.now() - startTime;
    const rate = duration > 0 ? Math.round(addedCount / (duration / 1000)) : 0;
    console.log(`✅ Added ${addedCount} chunks in ${duration}ms (${rate} chunks/s)`);
    if (skippedCount > 0) {
      console.warn(`⚠️  Skipped ${skippedCount} chunks due to validation errors`);
    }
  }

  /**
   * Search for nearest neighbors
   */
  async search(
    queryEmbedding: Float32Array,
    k: number = 10,
    documentIds?: string[]
  ): Promise<SearchResult[]> {
    if (!this.isInitialized || !this.index) {
      throw new Error('HNSW index not initialized');
    }

    if (this.currentSize === 0) {
      return [];
    }

    // Validate query embedding dimension
    if (queryEmbedding.length !== this.dimension) {
      throw new Error(
        `Query embedding dimension mismatch: expected ${this.dimension}, got ${queryEmbedding.length}`
      );
    }

    // Validate query embedding values
    for (let i = 0; i < queryEmbedding.length; i++) {
      if (!Number.isFinite(queryEmbedding[i])) {
        throw new Error(`Invalid query embedding value at index ${i}`);
      }
    }

    // Set search accuracy
    this.index.setEf(this.efSearch);

    // Perform search with error handling
    let result: { neighbors: number[]; distances: number[] };
    try {
      // Convert Float32Array to number[]
      const queryArray = Array.from(queryEmbedding);
      result = this.index.searchKnn(queryArray, Math.min(k * 2, this.currentSize));
    } catch (error) {
      throw new Error(`HNSW search failed: ${error.message}`);
    }

    // Convert labels to chunks
    const searchResults: SearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const similarity = 1 - result.distances[i]; // Convert distance to similarity

      const chunkId = this.chunkIdMap.get(label);
      if (!chunkId) continue;

      const chunk = this.chunkDataMap.get(chunkId);
      if (!chunk) continue;

      // Filter by document IDs if provided
      if (documentIds && !documentIds.includes(chunk.documentId)) {
        continue;
      }

      searchResults.push({
        chunk,
        similarity,
        document: null as any, // Will be populated by VectorStore wrapper
      });

      if (searchResults.length >= k) {
        break;
      }
    }

    return searchResults;
  }

  /**
   * Save index to disk with atomic write (write to temp, then rename)
   */
  async save(): Promise<void> {
    if (!this.isInitialized || !this.index) {
      return;
    }

    console.log('💾 Saving HNSW index to disk...');
    const startTime = Date.now();

    // Ensure directory exists
    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempIndexPath = this.indexPath + '.tmp';
    const metadataPath = this.indexPath + '.meta.json';
    const tempMetadataPath = metadataPath + '.tmp';

    try {
      // Save HNSW index to temp file first
      this.index.writeIndexSync(tempIndexPath);

      // Save metadata to temp file
      const metadata = {
        version: 1, // Schema version for future compatibility
        dimension: this.dimension,
        currentSize: this.currentSize,
        savedAt: new Date().toISOString(),
        chunkIdMap: Array.from(this.chunkIdMap.entries()),
        chunkDataMap: Array.from(this.chunkDataMap.entries()),
      };
      fs.writeFileSync(tempMetadataPath, JSON.stringify(metadata));

      // Atomic rename: temp -> final (prevents corruption if interrupted)
      fs.renameSync(tempIndexPath, this.indexPath);
      fs.renameSync(tempMetadataPath, metadataPath);

      const duration = Date.now() - startTime;
      console.log(`✅ HNSW index saved in ${duration}ms`);
    } catch (error) {
      // Clean up temp files on failure
      try {
        if (fs.existsSync(tempIndexPath)) fs.unlinkSync(tempIndexPath);
        if (fs.existsSync(tempMetadataPath)) fs.unlinkSync(tempMetadataPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw new Error(`Failed to save HNSW index: ${error.message}`);
    }
  }

  /**
   * Load metadata from disk with validation
   * Returns true if metadata was loaded successfully, false otherwise
   */
  async loadMetadata(): Promise<boolean> {
    const metadataPath = this.indexPath + '.meta.json';

    if (!fs.existsSync(metadataPath)) {
      console.warn('⚠️  No metadata file found');
      return false;
    }

    try {
      const content = fs.readFileSync(metadataPath, 'utf-8');

      // Validate JSON is not empty or truncated
      if (!content || content.trim().length < 10) {
        console.warn('⚠️  Metadata file is empty or truncated');
        this.wasCorrupted = true;
        fs.unlinkSync(metadataPath);
        return false;
      }

      const metadata = JSON.parse(content);

      // Validate metadata structure
      if (typeof metadata.currentSize !== 'number' ||
          !Array.isArray(metadata.chunkIdMap) ||
          !Array.isArray(metadata.chunkDataMap)) {
        console.warn('⚠️  Metadata file has invalid structure');
        this.wasCorrupted = true;
        fs.unlinkSync(metadataPath);
        return false;
      }

      // Validate dimension matches (if specified in metadata)
      if (metadata.dimension && metadata.dimension !== this.dimension) {
        console.warn(
          `⚠️  Metadata dimension mismatch: file has ${metadata.dimension}, expected ${this.dimension}`
        );
        this.wasCorrupted = true;
        fs.unlinkSync(metadataPath);
        return false;
      }

      this.currentSize = metadata.currentSize;
      this.chunkIdMap = new Map(metadata.chunkIdMap);
      this.chunkDataMap = new Map(metadata.chunkDataMap);
      console.log(`✅ Loaded metadata: ${this.currentSize} chunks`);
      return true;
    } catch (error) {
      console.error('❌ Failed to load metadata:', error.message);
      this.wasCorrupted = true;

      // Delete corrupted metadata file
      try {
        fs.unlinkSync(metadataPath);
      } catch (deleteError) {
        // Ignore
      }
      return false;
    }
  }

  /**
   * Clear all data
   */
  async clear(): Promise<void> {
    this.index = new HierarchicalNSW('cosine', this.dimension);
    this.index.initIndex(this.maxElements, this.M, this.efConstruction);
    this.chunkIdMap.clear();
    this.chunkDataMap.clear();
    this.currentSize = 0;
    this.isInitialized = true;

    // Delete index files
    if (fs.existsSync(this.indexPath)) {
      fs.unlinkSync(this.indexPath);
    }
    const metadataPath = this.indexPath + '.meta.json';
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    dimension: number;
    currentSize: number;
    maxElements: number;
    M: number;
    efConstruction: number;
    efSearch: number;
  } {
    return {
      dimension: this.dimension,
      currentSize: this.currentSize,
      maxElements: this.maxElements,
      M: this.M,
      efConstruction: this.efConstruction,
      efSearch: this.efSearch,
    };
  }

  /**
   * Set search accuracy (higher = more accurate but slower)
   */
  setSearchAccuracy(ef: number): void {
    this.efSearch = Math.max(10, Math.min(500, ef));
  }

  /**
   * Check if chunk exists in index
   */
  hasChunk(chunkId: string): boolean {
    return this.chunkDataMap.has(chunkId);
  }

  /**
   * Get total number of chunks
   */
  getSize(): number {
    return this.currentSize;
  }
}
